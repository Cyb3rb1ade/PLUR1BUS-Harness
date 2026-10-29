//! Bounded MCPB appended-signature framing and read-only ZIP prefix, without cryptographic verification (M-A9).
use super::SignatureStatus;
use crate::refusal::{reason, Refusal};
use crate::zipaudit::Limits;
use std::io::{self, Read, Seek, SeekFrom};

const HEADER: &[u8] = b"MCPB_SIG_V1";
const FOOTER: &[u8] = b"MCPB_SIG_END";
// Certificate chains are bounded separately so framing never requires buffering an entire package.
const MAX_SIGNATURE_BYTES: usize = 1 << 20;
const MAX_TRAILER_BYTES: usize = MAX_SIGNATURE_BYTES + HEADER.len() + 4 + FOOTER.len();

fn invalid(detail: &str) -> Refusal {
    Refusal::invalid(reason::SIGNATURE_INVALID, detail)
}

/// A seekable view that never exposes the source signature to the strict archive audit.
pub(super) struct ZipPrefix<'a, R> {
    inner: &'a mut R,
    length: u64,
    position: u64,
}

impl<R: Read> Read for ZipPrefix<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = buffer
            .len()
            .min(self.length.saturating_sub(self.position) as usize);
        let read = self.inner.read(&mut buffer[..count])?;
        self.position += read as u64;
        Ok(read)
    }
}

impl<R: Seek> Seek for ZipPrefix<'_, R> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(n) => i128::from(n),
            SeekFrom::End(n) => i128::from(self.length) + i128::from(n),
            SeekFrom::Current(n) => i128::from(self.position) + i128::from(n),
        };
        if position < 0 || position > i128::from(self.length) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek outside MCPB ZIP prefix",
            ));
        }
        self.position = self.inner.seek(SeekFrom::Start(position as u64))?;
        Ok(self.position)
    }
}

fn der_element(bytes: &[u8], tag: u8) -> Result<(&[u8], &[u8]), Refusal> {
    if bytes.first() != Some(&tag) || bytes.len() < 2 {
        return Err(invalid(
            "MCPB signature is not a DER PKCS#7 ContentInfo envelope",
        ));
    }
    let (length, start) = if bytes[1] < 0x80 {
        (usize::from(bytes[1]), 2)
    } else {
        let count = usize::from(bytes[1] & 0x7f);
        if count == 0 || count > 4 || bytes.len() < 2 + count || bytes[2] == 0 {
            return Err(invalid("MCPB signature has an invalid DER length"));
        }
        let length = bytes[2..2 + count]
            .iter()
            .fold(0usize, |n, b| (n << 8) | usize::from(*b));
        if length < 128 {
            return Err(invalid("MCPB signature DER length is not canonical"));
        }
        (length, 2 + count)
    };
    let end = start
        .checked_add(length)
        .ok_or_else(|| invalid("MCPB signature DER length overflow"))?;
    if end > bytes.len() {
        return Err(invalid("MCPB signature DER payload is truncated"));
    }
    Ok((&bytes[start..end], &bytes[end..]))
}

fn check_der(bytes: &[u8]) -> Result<(), Refusal> {
    let (content, rest) = der_element(bytes, 0x30)?;
    if !rest.is_empty() {
        return Err(invalid(
            "MCPB signature contains data after DER ContentInfo",
        ));
    }
    let (oid, envelope) = der_element(content, 0x06)?;
    if oid != b"\x2a\x86\x48\x86\xf7\x0d\x01\x07\x02" {
        return Err(invalid("MCPB signature ContentInfo is not signedData"));
    }
    let (signed, rest) = der_element(envelope, 0xa0)?;
    if !rest.is_empty() {
        return Err(invalid(
            "MCPB signature contains data after signedData envelope",
        ));
    }
    let (_, rest) = der_element(signed, 0x30)?;
    if !rest.is_empty() {
        return Err(invalid("MCPB signedData envelope contains trailing data"));
    }
    // Only framing is checked. Signer info, certificate chain and content binding remain unverified.
    Ok(())
}

fn check_trailer(bytes: &[u8]) -> Result<SignatureStatus, Refusal> {
    if bytes.is_empty() {
        return Ok(SignatureStatus::Unsigned);
    }
    if !bytes.starts_with(HEADER) || bytes.len() < HEADER.len() + 4 + FOOTER.len() {
        return Err(invalid(
            "MCPB data after ZIP is not a complete signature block",
        ));
    }
    let length = u32::from_le_bytes(
        bytes[HEADER.len()..HEADER.len() + 4]
            .try_into()
            .expect("four-byte signature length"),
    ) as usize;
    if length > MAX_SIGNATURE_BYTES {
        return Err(Refusal::invalid(
            reason::TOO_LARGE,
            "MCPB signature exceeds 1 MiB",
        ));
    }
    let start = HEADER.len() + 4;
    if length == 0 || start + length + FOOTER.len() != bytes.len() || !bytes.ends_with(FOOTER) {
        return Err(invalid(
            "MCPB signature length or terminal marker does not match; no trailing data is allowed",
        ));
    }
    check_der(&bytes[start..start + length])?;
    Ok(SignatureStatus::NotChecked)
}

pub(super) fn zip_prefix<'a, R: Read + Seek>(
    input: &'a mut R,
    limits: &Limits,
) -> Result<(ZipPrefix<'a, R>, SignatureStatus), Refusal> {
    let total = input.seek(SeekFrom::End(0)).map_err(|e| Refusal::io(&e))?;
    if total
        > limits
            .package_bytes
            .saturating_add(MAX_TRAILER_BYTES as u64)
    {
        return Err(Refusal::invalid(
            reason::TOO_LARGE,
            "MCPB archive and signature exceed the package size limit",
        ));
    }
    let count = total.min((MAX_TRAILER_BYTES + 22) as u64) as usize;
    let offset = total - count as u64;
    input
        .seek(SeekFrom::Start(offset))
        .map_err(|e| Refusal::io(&e))?;
    let mut tail = vec![0; count];
    input.read_exact(&mut tail).map_err(|e| Refusal::io(&e))?;
    let end = (0..count.saturating_sub(21)).rev().find(|&at| {
        let header = &tail[at..at + 22];
        if &header[..4] != b"PK\x05\x06" || header[20..22] != [0, 0] {
            return false;
        }
        let central_length =
            u32::from_le_bytes(header[12..16].try_into().expect("four-byte central length"));
        let central_offset =
            u32::from_le_bytes(header[16..20].try_into().expect("four-byte central offset"));
        u64::from(central_length) + u64::from(central_offset) == offset + at as u64
    });
    let (length, signature) = match end {
        Some(at) => (offset + at as u64 + 22, check_trailer(&tail[at + 22..])?),
        // Let the existing audit identify unsupported comments, ZIP64 and malformed archives.
        None => (total, SignatureStatus::Unsigned),
    };
    input
        .seek(SeekFrom::Start(0))
        .map_err(|e| Refusal::io(&e))?;
    Ok((
        ZipPrefix {
            inner: input,
            length,
            position: 0,
        },
        signature,
    ))
}

# Docker Engine HTTP transport for Windows. No Docker lifecycle CLI or shell interpolation.
$ErrorActionPreference = 'Stop'
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $env:PLUR1BUS_PIPE, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
$pipe.Connect(5000)
$output = [Console]::OpenStandardOutput()
function Read-Bytes([int]$size) {
    $buffer = [byte[]]::new($size)
    $position = 0
    while ($position -lt $size) {
        $task = $pipe.ReadAsync($buffer, $position, $size - $position)
        if (-not $task.Wait(300000)) { throw 'Docker pipe read deadline exceeded' }
        $count = $task.Result
        if ($count -eq 0) { throw 'Docker pipe response truncated' }
        $position += $count
    }
    return ,$buffer
}
function Read-Line {
    $bytes = [Collections.Generic.List[byte]]::new()
    while ($true) {
        $b = (Read-Bytes 1)[0]
        if ($b -eq 10) { break }
        if ($bytes.Count -ge 65536) { throw 'Docker pipe header too large' }
        $bytes.Add($b)
    }
    return [Text.Encoding]::ASCII.GetString($bytes.ToArray()).TrimEnd([char]13)
}
try {
    $body = if ($env:PLUR1BUS_PIPE_FILE) { [IO.File]::OpenRead($env:PLUR1BUS_PIPE_FILE) } else {
        $memory = [IO.MemoryStream]::new()
        [Console]::OpenStandardInput().CopyTo($memory)
        $memory.Position = 0
        $memory
    }
    $authorization = if ($env:PLUR1BUS_PIPE_AUTH) { "X-Registry-Auth: $($env:PLUR1BUS_PIPE_AUTH)`r`n" } else { '' }
    $header = "$($env:PLUR1BUS_PIPE_METHOD) $($env:PLUR1BUS_PIPE_PATH) HTTP/1.1`r`nHost: localhost`r`nConnection: close`r`nContent-Type: $($env:PLUR1BUS_PIPE_TYPE)`r`nContent-Length: $($body.Length)`r`n${authorization}`r`n"
    $bytes = [Text.Encoding]::ASCII.GetBytes($header)
    $pipe.Write($bytes, 0, $bytes.Length)
    $body.CopyTo($pipe); $pipe.Flush(); $body.Dispose()
    $status = (Read-Line).Split(' ')[1]
    $headers = @{}
    while ($true) { $line = Read-Line; if (-not $line) { break }; $parts = $line.Split(':', 2); $headers[$parts[0].ToLowerInvariant()] = $parts[1].Trim() }
    if ($headers['transfer-encoding'] -eq 'chunked') {
        while ($true) {
            $length = [Convert]::ToInt32((Read-Line).Split(';')[0], 16)
            if ($length -eq 0) { break }
            while ($length -gt 0) {
                $size = [Math]::Min($length, 65536)
                $chunk = Read-Bytes $size; $output.Write($chunk, 0, $chunk.Length); $output.Flush()
                $length -= $size
            }
            if ((Read-Line) -ne '') { throw 'invalid chunk separator' }
        }
    } elseif ($headers.ContainsKey('content-length')) {
        $remaining = [long]$headers['content-length']
        while ($remaining -gt 0) {
            $size = [int][Math]::Min($remaining, 65536)
            $chunk = Read-Bytes $size; $output.Write($chunk, 0, $chunk.Length); $output.Flush(); $remaining -= $size
        }
    } else {
        $buffer = [byte[]]::new(65536)
        while ($true) {
            $task = $pipe.ReadAsync($buffer, 0, $buffer.Length)
            if (-not $task.Wait(300000)) { throw 'Docker pipe deadline exceeded' }
            if ($task.Result -eq 0) { break }
            $output.Write($buffer, 0, $task.Result); $output.Flush()
        }
    }
    if ($env:PLUR1BUS_PIPE_STREAM -ne '1') {
        $tail = [Text.Encoding]::ASCII.GetBytes("`n$status")
        $output.Write($tail, 0, $tail.Length)
    }
    if ([int]$status -ge 400 -and [int]$status -ne 404) { throw "Docker HTTP $status" }
} finally { $pipe.Dispose() }

# Desktop payload metadata

`bundle.json.tmpl` is deliberately a non-production template: zero digests, no vendor download endpoints, and the synthetic image name. Do not replace it with a developer's mutable local tag. Production packaging supplies an independently reviewed `PLUR1BUS_DESKTOP_RELEASE_MANIFEST` and matching release artifact paths to `scripts/build-bundle.mjs`.

The actual M8 image source is `containers/harness/Dockerfile`, built through `containers/build.sh`. `scripts/real-image-probe.mjs` records runtime/CLI compatibility of an immutable image identity without modifying API policy or claiming the authenticated desktop gate. A working daemon does not satisfy the still-missing desktop bootstrap/session/cold-snapshot contracts. See `docs/handoff/status/2026-10-15-d1-p3.md` from the repository root.

A production image reference must come from the release pipeline with both architecture digests. Offline payload staging maps the selected OCI archive to `image/plur1bus-harness-<arch>.oci.tar`; models are separate resources. The controller verifies the runtime's loaded image digest before creating objects. CI fixtures are valid OCI archives explicitly labelled non-runnable, not substitutes for the real harness or models. No registry publication, signing, credentials, or authoritative native installation identity is performed here.

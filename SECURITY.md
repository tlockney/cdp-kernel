# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
[open a private report](https://github.com/tlockney/cdp-kernel/security/advisories/new)
(the **Report a vulnerability** button on the repository's **Security**
tab). Don't open a public issue for a security problem.

Include what an attacker needs (local access, a crafted notebook, a
malicious package), the steps to reproduce, the `cdp-kernel version`, and
the host and target runtimes.

cdp-kernel is maintained by one person. Expect an acknowledgement within
7 days. A confirmed problem is fixed in a new release, published with a
GitHub security advisory that credits the reporter unless you'd rather it
didn't.

## Supported versions

Fixes go into the next release. Only the latest release is supported;
there are no backports to older versions before 1.0.

## Threat model

A Jupyter kernel runs whatever code it's sent. That is its purpose, so
"a cell can read my files" or "a notebook can start processes" is not a
vulnerability. What matters is who can send code to the kernel, or reach
the processes it runs.

### What protects the kernel

- **The Jupyter sockets.** The kernel listens on the address and ports in
  the connection file the frontend writes (`127.0.0.1` unless it says
  otherwise). Every message is signed with HMAC-SHA256 using the
  connection file's `key`, and the kernel drops messages whose signature
  doesn't match. Anyone who can read the connection file can run code in
  the kernel, so it must stay readable only by you. Jupyter writes it that
  way and always sets a key; a connection file with an empty `key`
  disables the check, as it does for every Jupyter kernel.
- **The channel to the target runtime.** The host drives the runtime
  that runs your cells over a channel only the host can reach:
  - Node and Deno: the inspector (Chrome DevTools Protocol) on
    `127.0.0.1` with a random port. Its WebSocket has no authentication,
    so the kernel has the runtime print the URL's random id only to the
    host's private stderr pipe instead of listing it at `/json/list` for
    any local process to find.
  - Bun: a pipe inherited from the host.
  - workerd: a Unix socket in a private temporary directory, plus a
    per-launch token.
  - celld: a loopback WebSocket with a per-launch token.

### In scope

- Running code in a kernel, or reading its output, without the
  connection file's key.
- Reaching a target runtime's inspector or channel from another process
  or user.
- Files the kernel writes (kernelspecs, caches, temporary directories)
  with permissions that let another user read or change them.
- A frontend message that makes the host itself (not the target) run
  code or read files it wasn't asked to.

### Out of scope

- Anything a cell does when it runs. Deno targets run with
  `--allow-all`, and Node and Bun have no permission system on by
  default, so cells on those runtimes have your user's access. workerd
  and celld restrict what a cell can reach, but the kernel doesn't treat
  that as a security boundary.
- Packages a notebook imports (`npm:`, `jsr:`, URLs). The kernel installs
  what the notebook names.
- Exposing the kernel's ports to a network yourself (a connection file
  with a public `ip`, port forwarding). Use the Jupyter server's own
  authentication and TLS for remote access.
- Vulnerabilities in Node, Deno, Bun, workerd, celld or Jupyter
  themselves. Report those to their projects; tell us if cdp-kernel needs
  to change because of one.

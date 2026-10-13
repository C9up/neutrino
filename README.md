# @c9up/neutrino

Protocol Buffers and gRPC for the Ream framework.

Neutrino gives Ream a schema-enforced, cross-language contract: one `.proto`
shared by the server and its non-JS clients (mobile apps, Go or Rust services),
instead of a JSON shape documented by hand.

It is additive. JSON stays the default for the web path, and an application that
does not use Neutrino never installs it.

## Status

Nothing usable yet: this repository holds the package skeleton. The codec, the
HTTP and realtime seams and the gRPC transport land in later releases.

## License

MIT

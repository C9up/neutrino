# @c9up/neutrino

Protocol Buffers and gRPC for the Ream framework.

Neutrino gives Ream a schema-enforced, cross-language contract: one `.proto`
shared by the server and its non-JS clients (mobile apps, Go or Rust services),
instead of a JSON shape documented by hand.

It is additive. JSON stays the default for the web path, and an application that
does not use Neutrino never installs it.

## Status

The codec is here: schemas loaded from descriptor sets or generated files, and
encode / decode over them. The HTTP and gRPC transports land in later releases.

## Schemas

Neutrino reads compiled schemas, not `.proto` text:

- a binary `FileDescriptorSet`, as `buf build -o app.binpb` or
  `protoc --include_imports --descriptor_set_out=app.binpb app.proto` writes it;
- the file descriptors `protoc-gen-es` generates (its `file_*` exports), which
  also give you typed messages.

Messages are [`@bufbuild/protobuf`](https://github.com/bufbuild/protobuf-es)
messages: no code generated at runtime, unknown fields kept, a recursion limit
on decode.

## Use

```ts
import { create } from "@bufbuild/protobuf"
import { Protobuf } from "@c9up/neutrino"
import { file_echo, SayRequestSchema } from "./gen/echo_pb.js"

const protobuf = new Protobuf({ files: [file_echo] })

const bytes = protobuf.encode(SayRequestSchema, create(SayRequestSchema, { text: "hi" }))
const request = protobuf.decode(SayRequestSchema, bytes)

protobuf.message("echo.SayRequest") // a schema by type name
protobuf.method("/echo.Echo/Say")   // a method by gRPC path: input, output, kind
```

Bytes that do not decode — truncated, malformed, invalid UTF-8, nested too deep —
raise `InvalidMessageError` (`E_NEUTRINO_INVALID_MESSAGE`), the error a transport
answers with a client error. Two sources that declare the same type differently
raise `DuplicateTypeError` instead of one silently replacing the other.

## In a Ream application

```ts
// reamrc.ts
providers: [() => import("@c9up/neutrino/provider")]

// config/protobuf.ts
import { defineConfig } from "@c9up/neutrino"

export default defineConfig({
  descriptorSets: [app.makePath("proto/app.binpb")],
})
```

The schemas load at boot, so a missing file or a conflict stops the start
rather than the first request. The instance is bound as `protobuf` and is
reachable from `@c9up/neutrino/services/main`.

## License

MIT

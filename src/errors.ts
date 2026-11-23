/**
 * The errors of neutrino, one class per code. A caller tests `error.code` or
 * `error instanceof errors.E_NEUTRINO_…`.
 */

import { createError, Exception } from "@c9up/flare";
import type { GrpcStatusCode } from "./GrpcServices.js";

/** `@c9up/neutrino/services/main` or `/services/grpc` was used before the provider ran. */
export const E_NEUTRINO_NOT_BOOTED = createError<[string, string]>(
	"[%s] accessed before initialization — register NeutrinoProvider, or call %s() yourself.",
	"E_NEUTRINO_NOT_BOOTED",
);

/** The server has no `grpc()` method. */
export const E_NEUTRINO_GRPC_UNSUPPORTED = createError(
	"Neutrino: this server cannot serve gRPC — it has no grpc() method. Upgrade @c9up/ream.",
	"E_NEUTRINO_GRPC_UNSUPPORTED",
);

/** `config/protobuf.ts` is missing. */
export const E_NEUTRINO_MISSING_CONFIG = createError(
	"[protobuf] missing config/protobuf.ts",
	"E_NEUTRINO_MISSING_CONFIG",
);

/** `config/protobuf.ts` does not export a usable config. */
export const E_NEUTRINO_INVALID_CONFIG = createError<[string]>(
	"[protobuf] %s",
	"E_NEUTRINO_INVALID_CONFIG",
);

/** The container answered a token with something of another class. */
export const E_NEUTRINO_INVALID_BINDING = createError<[string, string, string]>(
	"[%s] the container returned something that is not %s for the %s token.",
	"E_NEUTRINO_INVALID_BINDING",
);

/** A descriptor set cannot be read as a `FileDescriptorSet`. */
export const E_NEUTRINO_INVALID_DESCRIPTOR = createError<[string]>(
	"Neutrino: %s is not a valid FileDescriptorSet",
	"E_NEUTRINO_INVALID_DESCRIPTOR",
);

/**
 * Two sources declare the same type differently.
 *
 * The registry underneath keeps the last one without a word, so a stale copy
 * of a `.proto` loaded after the current one would silently decode every
 * message of that type with the wrong fields. The same file included twice,
 * byte for byte, is not a conflict: descriptor sets built with their imports
 * routinely repeat `google/protobuf/*.proto`.
 */
export const E_NEUTRINO_DUPLICATE_TYPE = createError<[string, string, string]>(
	'Neutrino: "%s" is declared by %s and, differently, by %s',
	"E_NEUTRINO_DUPLICATE_TYPE",
);

/** A type name is not in any loaded descriptor. */
export const E_NEUTRINO_UNKNOWN_TYPE = createError<
	["message" | "service", string]
>('Neutrino: no %s type "%s" is loaded', "E_NEUTRINO_UNKNOWN_TYPE");

/** A gRPC method path does not name a loaded method. */
export const E_NEUTRINO_UNKNOWN_METHOD = createError<[string]>(
	'Neutrino: no method "%s" is loaded',
	"E_NEUTRINO_UNKNOWN_METHOD",
);

/**
 * Bytes do not decode as the expected message — truncated, malformed,
 * invalid UTF-8 in a string field, or nested past the recursion limit. The
 * bytes come from the client, so a transport answers it with a 400 or
 * `INVALID_ARGUMENT`; the decoder's own error is kept as the cause.
 */
export const E_NEUTRINO_INVALID_MESSAGE = createError<[string]>(
	"Neutrino: the bytes are not a valid %s",
	"E_NEUTRINO_INVALID_MESSAGE",
	400,
);

/**
 * A call's `-bin` metadata value is not base64. A transport answers it
 * INTERNAL, as it does a malformed `grpc-timeout`.
 */
export class E_NEUTRINO_INVALID_METADATA extends Exception {
	static override code = "E_NEUTRINO_INVALID_METADATA";

	constructor(public readonly key: string) {
		super(`Invalid binary metadata "${key}"`);
	}
}

/** The bearer token verifier failed (not the token: the verifier). */
export const E_NEUTRINO_VERIFIER_FAILED = createError(
	"The token verifier failed",
	"E_NEUTRINO_VERIFIER_FAILED",
);

/** A message-size option is not a whole number of bytes, or -1. */
export const E_NEUTRINO_INVALID_OPTION = createError<[string, number]>(
	"Neutrino: %s must be a whole number of bytes, or -1 for no limit — got %s",
	"E_NEUTRINO_INVALID_OPTION",
);

/** A service is registered twice. */
export const E_NEUTRINO_DUPLICATE_SERVICE = createError<[string]>(
	'Neutrino: service "%s" is already registered',
	"E_NEUTRINO_DUPLICATE_SERVICE",
);

/** A method's implementation is not a function. */
export const E_NEUTRINO_INVALID_IMPLEMENTATION = createError<[string]>(
	'Neutrino: the implementation of "%s" is not a function',
	"E_NEUTRINO_INVALID_IMPLEMENTATION",
);

/** A streaming method was registered; only unary ones are served. */
export const E_NEUTRINO_STREAMING_UNSUPPORTED = createError<[string, string]>(
	'Neutrino: %s method "%s" cannot be served yet — unary only',
	"E_NEUTRINO_STREAMING_UNSUPPORTED",
);

/** A method or an interceptor answered something that is not a message. */
export const E_NEUTRINO_INVALID_REPLY = createError<[string]>(
	"%s",
	"E_NEUTRINO_INVALID_REPLY",
);

/** An interceptor called `next()` more than once. */
export const E_NEUTRINO_NEXT_CALLED_TWICE = createError<[string]>(
	"An interceptor of %s called next() more than once",
	"E_NEUTRINO_NEXT_CALLED_TWICE",
);

/**
 * Thrown by a method implementation to answer a gRPC status instead of a
 * reply. Its message is sent to the client as the status details; any other
 * error is answered INTERNAL and its message is NOT sent. The gRPC status is
 * `grpcStatus`.
 */
export class E_NEUTRINO_GRPC_STATUS extends Exception {
	static override code = "E_NEUTRINO_GRPC_STATUS";

	constructor(
		public readonly grpcStatus: GrpcStatusCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

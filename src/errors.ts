/**
 * Neutrino errors. No upstream package exists, so every code carries the
 * namespace — there is no upstream id to keep verbatim.
 */

export class NeutrinoError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

/** Raised when a descriptor set cannot be read as a `FileDescriptorSet`. */
export class InvalidDescriptorError extends NeutrinoError {
	constructor(source: string, options?: ErrorOptions) {
		super(
			"E_NEUTRINO_INVALID_DESCRIPTOR",
			`Neutrino: ${source} is not a valid FileDescriptorSet`,
			options,
		);
	}
}

/**
 * Raised when two sources declare the same type differently.
 *
 * The registry underneath keeps the last one without a word, so a stale copy
 * of a `.proto` loaded after the current one would silently decode every
 * message of that type with the wrong fields. The same file included twice,
 * byte for byte, is not a conflict: descriptor sets built with their imports
 * routinely repeat `google/protobuf/*.proto`.
 */
export class DuplicateTypeError extends NeutrinoError {
	constructor(typeName: string, first: string, second: string) {
		super(
			"E_NEUTRINO_DUPLICATE_TYPE",
			`Neutrino: "${typeName}" is declared by ${first} and, differently, by ${second}`,
		);
	}
}

/** Raised when a type name is not in any loaded descriptor. */
export class UnknownTypeError extends NeutrinoError {
	constructor(typeName: string, kind: "message" | "service" = "message") {
		super(
			"E_NEUTRINO_UNKNOWN_TYPE",
			`Neutrino: no ${kind} type "${typeName}" is loaded`,
		);
	}
}

/** Raised when a gRPC method path does not name a loaded method. */
export class UnknownMethodError extends NeutrinoError {
	constructor(path: string) {
		super(
			"E_NEUTRINO_UNKNOWN_METHOD",
			`Neutrino: no method "${path}" is loaded`,
		);
	}
}

/**
 * Raised when bytes do not decode as the expected message — truncated,
 * malformed, invalid UTF-8 in a string field, or nested past the recursion
 * limit. The bytes come from the client, so this is the error a transport
 * answers with a 400 or `INVALID_ARGUMENT`; the decoder's own error is kept as
 * the cause.
 */
export class InvalidMessageError extends NeutrinoError {
	constructor(typeName: string, options?: ErrorOptions) {
		super(
			"E_NEUTRINO_INVALID_MESSAGE",
			`Neutrino: the bytes are not a valid ${typeName}`,
			options,
		);
	}
}

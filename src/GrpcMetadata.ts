/**
 * The metadata of a received call, as an application reads it.
 *
 *   context.metadata.get("x-request-id")  // ["r1"] — every value, in order
 *   context.metadata.get("trace-bin")     // [Uint8Array] — `-bin` keys decoded
 *   context.metadata.getMap()             // { "x-request-id": "r1", ... } — first values
 *
 * Keys are lowercase. The headers that belong to the transport — the
 * pseudo-headers, `content-type`, `te`, `grpc-timeout`, `grpc-encoding`,
 * `grpc-accept-encoding`, `accept-encoding` — are not metadata and are left
 * out, as a gRPC server does before the application sees the call.
 */

import { Buffer } from "node:buffer";
import { InvalidMetadataError } from "./errors.js";

export type MetadataValue = string | Uint8Array;

/** Headers the transport consumes; never handed to the application. */
const TRANSPORT_HEADERS = new Set([
	"content-type",
	"te",
	"grpc-timeout",
	"grpc-encoding",
	"grpc-accept-encoding",
	"accept-encoding",
]);

/** Standard base64, padded or not — the two forms the gRPC spec accepts. */
const BASE64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

function decodeBinary(key: string, value: string): Uint8Array[] {
	// A custom key may carry several values joined with commas; a `grpc-` key
	// is one value.
	const parts = key.startsWith("grpc-") ? [value] : value.split(",");
	return parts.map((part) => {
		const text = part.trim();
		if (!BASE64.test(text)) throw new InvalidMetadataError(key);
		// Copied out of Buffer's shared pool, into a plain Uint8Array.
		return new Uint8Array(Buffer.from(text, "base64"));
	});
}

export class GrpcMetadata {
	readonly #entries = new Map<string, MetadataValue[]>();

	/**
	 * @param headers the call's request headers, a repeated one as a list.
	 * @throws InvalidMetadataError on a `-bin` value that is not base64.
	 */
	constructor(
		headers: Readonly<Record<string, string | readonly string[]>> = {},
	) {
		for (const [name, raw] of Object.entries(headers)) {
			const key = name.toLowerCase();
			if (key.startsWith(":") || TRANSPORT_HEADERS.has(key)) continue;
			const values = typeof raw === "string" ? [raw] : raw;
			const decoded: MetadataValue[] = key.endsWith("-bin")
				? values.flatMap((value) => decodeBinary(key, value))
				: [...values];
			const existing = this.#entries.get(key);
			if (existing === undefined) this.#entries.set(key, decoded);
			else existing.push(...decoded);
		}
	}

	/** Every value of `key`, in the order received; `[]` when absent. */
	get(key: string): MetadataValue[] {
		return (this.#entries.get(key.toLowerCase()) ?? []).map(copy);
	}

	/** The first value of each key. */
	getMap(): Record<string, MetadataValue> {
		const firsts: [string, MetadataValue][] = [];
		for (const [key, values] of this.#entries) {
			const first = values[0];
			if (first !== undefined) firsts.push([key, copy(first)]);
		}
		// Defined, not assigned, and without a prototype: a header may be
		// named `__proto__`.
		const map = Object.fromEntries(firsts);
		Object.setPrototypeOf(map, null);
		return map;
	}
}

function copy(value: MetadataValue): MetadataValue {
	return typeof value === "string" ? value : value.slice();
}

/**
 * The loaded {@link Protobuf}, reachable without threading it through every
 * call site — mirroring `@c9up/quasar/services/main`.
 *
 *   import protobuf from "@c9up/neutrino/services/main"
 *
 *   const request = protobuf.decode(SayRequestSchema, bytes)
 *
 * Importing this module loads nothing: the instance is resolved on the first
 * member access, so a unit test that pulls it in transitively needs no booted
 * provider.
 */

import type { Protobuf } from "../Protobuf.js";

let instance: Protobuf | undefined;

/** Seat the instance — called by NeutrinoProvider, or by an app wiring its own. */
export function setProtobuf(protobuf: Protobuf): void {
	instance = protobuf;
}

/** The seated instance, if there is one. */
export function getProtobuf(): Protobuf | undefined {
	return instance;
}

/** Drop the instance IF it is still the one passed in (ownership guard). */
export function clearProtobuf(protobuf: Protobuf): void {
	if (instance === protobuf) instance = undefined;
}

const protobuf: Protobuf = new Proxy(Object.create(null), {
	get(_target, property) {
		// A module loader reads `then` and various symbols off what it imports
		// before anyone uses it. They are not members, so answer undefined and
		// let a genuine access be the one that reports.
		if (typeof property === "symbol" || property === "then") {
			return undefined;
		}
		if (!instance) {
			throw new Error(
				"[protobuf] accessed before initialization — register NeutrinoProvider, or call setProtobuf() yourself.",
			);
		}
		const value = Reflect.get(instance, property, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default protobuf;

/**
 * The {@link GrpcServices}, reachable without threading it through every
 * call site — mirroring `@c9up/quasar/services/main`.
 *
 *   import grpc from "@c9up/neutrino/services/grpc"
 *
 *   grpc.service(EchoService, { say: (request) => ({ text: request.text }) })
 *
 * Importing this module loads nothing: the instance is resolved on the first
 * member access, so a unit test that pulls it in transitively needs no booted
 * provider.
 */

import type { GrpcServices } from "../GrpcServices.js";

let instance: GrpcServices | undefined;

/** Seat the instance — called by NeutrinoProvider, or by an app wiring its own. */
export function setGrpc(grpc: GrpcServices): void {
	instance = grpc;
}

/** The seated instance, if there is one. */
export function getGrpc(): GrpcServices | undefined {
	return instance;
}

/** Drop the instance IF it is still the one passed in (ownership guard). */
export function clearGrpc(grpc: GrpcServices): void {
	if (instance === grpc) instance = undefined;
}

const grpc: GrpcServices = new Proxy(Object.create(null), {
	get(_target, property) {
		// A module loader reads `then` and various symbols off what it imports
		// before anyone uses it. They are not members, so answer undefined and
		// let a genuine access be the one that reports.
		if (typeof property === "symbol" || property === "then") {
			return undefined;
		}
		if (!instance) {
			throw new Error(
				"[grpc] accessed before initialization — register NeutrinoProvider, or call setGrpc() yourself.",
			);
		}
		const value = Reflect.get(instance, property, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default grpc;

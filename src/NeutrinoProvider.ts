/**
 * NeutrinoProvider — loads the schemas `config/protobuf.ts` names, binds the
 * {@link Protobuf} over them, and serves the {@link GrpcServices} on the
 * host's HTTP port.
 *
 *   // reamrc.ts
 *   providers: [() => import("@c9up/neutrino/provider")]
 *
 *   // start/grpc.ts — a preload, so it runs after the provider has booted
 *   import grpc from "@c9up/neutrino/services/grpc"
 *   grpc.service(EchoService, { say: (request) => ({ text: request.text }) })
 *
 * The host is duck-typed — this package stays publishable without importing
 * `@c9up/ream`.
 */

import { readFileSync } from "node:fs";
import "./augmentations.js";
import type { ProtobufConfig } from "./config.js";
import { NeutrinoError } from "./errors.js";
import { type GrpcCall, type GrpcReply, GrpcServices } from "./GrpcServices.js";
import { Protobuf } from "./Protobuf.js";
import { clearGrpc, setGrpc } from "./services/grpc.js";
import { clearProtobuf, setProtobuf } from "./services/main.js";

interface NeutrinoContainer {
	singleton(token: unknown, factory: () => unknown): void;
	/**
	 * `unknown`, not a generic `resolve<T>`: a signature promising a type
	 * nothing verified cannot be implemented without an unchecked cast, so the
	 * check lives here instead.
	 */
	resolve(token: unknown): Promise<unknown>;
	/** Optional: a host that cannot tell gets no gRPC server wired. */
	has?(token: unknown): boolean;
}

/** The part of the host's server neutrino uses — ream's `server.grpc()`. */
interface GrpcHost {
	grpc(handler: (call: GrpcCall) => Promise<GrpcReply>): unknown;
}

function isGrpcHost(value: unknown): value is GrpcHost {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "grpc") === "function"
	);
}
interface NeutrinoConfigStore {
	get(key: string): unknown;
}
export interface NeutrinoAppContext {
	container: NeutrinoContainer;
	config: NeutrinoConfigStore;
}

function isProtobufConfig(value: unknown): value is ProtobufConfig {
	if (typeof value !== "object" || value === null) return false;
	const sets = Reflect.get(value, "descriptorSets");
	const files = Reflect.get(value, "files");
	return (
		(sets === undefined || Array.isArray(sets)) &&
		(files === undefined || Array.isArray(files))
	);
}

export default class NeutrinoProvider {
	readonly #app: NeutrinoAppContext;
	#protobuf: Protobuf | undefined;
	#grpc: GrpcServices | undefined;

	constructor(app: NeutrinoAppContext) {
		this.#app = app;
	}

	register(): void {
		this.#app.container.singleton(Protobuf, () => {
			const raw = this.#app.config.get("protobuf");
			if (raw === undefined) {
				throw new Error("[protobuf] missing config/protobuf.ts");
			}
			if (!isProtobufConfig(raw)) {
				throw new Error(
					"[protobuf] config/protobuf.ts must export defineConfig({ descriptorSets, files }).",
				);
			}
			return new Protobuf({
				descriptorSets: (raw.descriptorSets ?? []).map((path) =>
					readFileSync(path),
				),
				files: raw.files ?? [],
			});
		});
		const resolve = (): Promise<Protobuf> => this.#resolve();
		this.#app.container.singleton("neutrino.protobuf", resolve);
		this.#app.container.singleton("protobuf", resolve);

		this.#app.container.singleton(
			GrpcServices,
			async () => new GrpcServices(await this.#resolve()),
		);
		const resolveGrpc = (): Promise<GrpcServices> => this.#resolveGrpc();
		this.#app.container.singleton("neutrino.grpc", resolveGrpc);
		this.#app.container.singleton("grpc", resolveGrpc);
	}

	/**
	 * Load at BOOT, not on first use: a missing descriptor file or two schemas
	 * that disagree is a startup error, not a failure on the first request
	 * that happens to need a message type.
	 */
	async boot(): Promise<void> {
		const protobuf = await this.#resolve();
		this.#protobuf = protobuf;
		setProtobuf(protobuf);

		const grpc = await this.#resolveGrpc();
		this.#grpc = grpc;
		setGrpc(grpc);
		await this.#serveGrpc(grpc);
	}

	async shutdown(): Promise<void> {
		if (this.#protobuf) clearProtobuf(this.#protobuf);
		if (this.#grpc) clearGrpc(this.#grpc);
		this.#protobuf = undefined;
		this.#grpc = undefined;
	}

	/**
	 * Hand the dispatcher to the host's server. A host with no `server`
	 * binding (neutrino used outside Ream) serves nothing; a server that has
	 * no `grpc()` is a ream too old to serve gRPC, and saying so beats
	 * silently answering every call as an HTTP request.
	 */
	async #serveGrpc(grpc: GrpcServices): Promise<void> {
		const { container } = this.#app;
		if (!container.has?.("server")) return;
		const server = await container.resolve("server");
		if (!isGrpcHost(server)) {
			throw new NeutrinoError(
				"E_NEUTRINO_GRPC_UNSUPPORTED",
				"Neutrino: this server cannot serve gRPC — it has no grpc() method. Upgrade @c9up/ream.",
			);
		}
		server.grpc(grpc.handle);
	}

	async #resolveGrpc(): Promise<GrpcServices> {
		const resolved = await this.#app.container.resolve(GrpcServices);
		if (!(resolved instanceof GrpcServices)) {
			throw new Error(
				"[grpc] the container returned something that is not GrpcServices for the GrpcServices token.",
			);
		}
		return resolved;
	}

	async #resolve(): Promise<Protobuf> {
		const resolved = await this.#app.container.resolve(Protobuf);
		if (!(resolved instanceof Protobuf)) {
			throw new Error(
				"[protobuf] the container returned something that is not a Protobuf for the Protobuf token.",
			);
		}
		return resolved;
	}
}

/**
 * NeutrinoProvider — loads the schemas `config/protobuf.ts` names and binds
 * the {@link Protobuf} over them.
 *
 *   // reamrc.ts
 *   providers: [() => import("@c9up/neutrino/provider")]
 *
 * The host is duck-typed — this package stays publishable without importing
 * `@c9up/ream`.
 */

import { readFileSync } from "node:fs";
import "./augmentations.js";
import type { ProtobufConfig } from "./config.js";
import { Protobuf } from "./Protobuf.js";
import { clearProtobuf, setProtobuf } from "./services/main.js";

interface NeutrinoContainer {
	singleton(token: unknown, factory: () => unknown): void;
	/**
	 * `unknown`, not a generic `resolve<T>`: a signature promising a type
	 * nothing verified cannot be implemented without an unchecked cast, so the
	 * check lives here instead.
	 */
	resolve(token: unknown): Promise<unknown>;
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
	}

	async shutdown(): Promise<void> {
		if (this.#protobuf) clearProtobuf(this.#protobuf);
		this.#protobuf = undefined;
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

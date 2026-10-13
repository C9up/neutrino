/**
 * Teach ream's `ContainerBindings` what `container.make(...)` returns for the
 * tokens neutrino binds.
 *
 * Loaded from the package barrel, so importing neutrino anywhere in the
 * application is enough — nobody writes a `declare module` of their own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentation below resolves the module it augments.
import type {} from "@c9up/ream/types";

import type { GrpcServices } from "./GrpcServices.js";
import type { Protobuf } from "./Protobuf.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The loaded schemas and their codec, bound by `NeutrinoProvider`. */
		"neutrino.protobuf": Protobuf;
		/** The same binding under the bare role name. */
		protobuf: Protobuf;
		/** The gRPC services served on the HTTP port, bound by `NeutrinoProvider`. */
		"neutrino.grpc": GrpcServices;
		/** The same binding under the bare role name. */
		grpc: GrpcServices;
	}
}

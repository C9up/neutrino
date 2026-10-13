import "./augmentations.js";

export { defineConfig, type ProtobufConfig } from "./config.js";
export {
	DuplicateTypeError,
	InvalidDescriptorError,
	InvalidMessageError,
	NeutrinoError,
	UnknownMethodError,
	UnknownTypeError,
} from "./errors.js";
export { Protobuf, type ProtobufSources } from "./Protobuf.js";

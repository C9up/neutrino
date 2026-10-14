import { GrpcServices, Protobuf } from "../src/index.js";
import { Admin, Echo, file_echo } from "./fixtures/gen/echo_pb.js";

const grpc = new GrpcServices(new Protobuf({ files: [file_echo] }));

// Correct: request and reply typed from the .proto.
grpc.service(Echo, {
	say: (request) => ({ text: request.text.repeat(request.times) }),
});

grpc.service(Admin, {
	// @ts-expect-error — `text` is a string in SayReply
	ping: () => ({ text: 42 }),
});

grpc.service(Admin, {
	// @ts-expect-error — no method `pnig` on Admin
	pnig: () => ({ text: "x" }),
});

grpc.service(Echo, {
	// @ts-expect-error — `watch` is server streaming: not implementable yet
	watch: () => ({ text: "x" }),
});

grpc.service(Echo, {
	// @ts-expect-error — `request.nope` does not exist on SayRequest
	say: (request) => ({ text: request.nope }),
});

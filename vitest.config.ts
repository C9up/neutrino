import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			// Set just under what the suite actually reaches, so the gate can
			// only be crossed downwards on purpose.
			thresholds: {
				lines: 98,
				statements: 96,
				branches: 83,
				functions: 100,
			},
		},
	},
});

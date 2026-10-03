/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: "node",
	// TypeScript 7 is the native build and exposes no JS compiler API, so
	// ts-jest cannot work here: babel strips the types instead and
	// `npx tsc --noEmit` stays the real typechecker.
	transform: {
		"^.+\\.tsx?$": [
			"babel-jest",
			{
				presets: [["@babel/preset-typescript", {}]],
				plugins: ["@babel/plugin-transform-modules-commonjs"],
			},
		],
	},
	// sources use NodeNext specifiers like "./config.js" that resolve to .ts files
	moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
	moduleFileExtensions: ["ts", "js", "json", "node"],
};

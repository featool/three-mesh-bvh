import typescript from '@rollup/plugin-typescript';

const baseConfig = {
	input: './src/index.ts',
	treeshake: false,
	external: p => /^three/.test( p ),
	plugins: [
		typescript( {
			tsconfig: './tsconfig.json',
			compilerOptions: {
				noEmit: false,
				declaration: false,
				allowJs: true,
			},
		} ),
	],
};

export default [
	{
		...baseConfig,

		output: {

			name: 'MeshBVHLib',
			extend: true,
			format: 'umd',
			file: './build/index.umd.cjs',
			sourcemap: true,

			globals: p => /^three/.test( p ) ? 'THREE' : null,

		},

	},
	{
		...baseConfig,

		output: {

			format: 'esm',
			file: './build/index.module.js',
			sourcemap: true,

		},

	}
];

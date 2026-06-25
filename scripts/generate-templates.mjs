// Standalone script: reads .template.ts files, strips TS types via tsc, applies preprocess,
// and writes .generated.ts files for both direct and indirect variants.

import * as glob from 'glob';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname, basename, sep } from 'path';
import { preprocess } from 'preprocess';
import ts from 'typescript';

function generateStars( num ) {

	let result = '';
	for ( let i = 0; i < num; i ++ ) {

		result += '*';

	}

	return result;

}

function stripTypes( code ) {

	const result = ts.transpileModule( code, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2020,
			module: ts.ModuleKind.ESNext,
			removeComments: false,
			noEmit: true,
			isolatedModules: true,
		},
	} );

	return result.outputText;

}

function processTemplate( inputFile ) {

	const inputPath = resolve( inputFile );
	const header = basename( inputPath ).replace( /\.template\.ts$/, '' );
	const stars = generateStars( header.length + 17 );
	const comment = `/************************************${ stars }/\n/* This file is generated from "${ header }.template.ts". */\n/************************************${ stars }/\n`;

	const outputDir = dirname( inputPath );
	const rawCode = readFileSync( inputPath, 'utf8' );

	// Clean up old .generated.js files
	[ '.generated.js', '_indirect.generated.js' ].forEach( ext => {

		const oldFile = resolve( outputDir, header + ext );
		if ( existsSync( oldFile ) ) {

			unlinkSync( oldFile );
			console.log( `  Cleaned: ${ header }${ ext }` );

		}

	} );

	// Generate each variant: preprocess FIRST (expands @if/@echo), then transpileModule (strips types)
	[ { suffix: '', indent: false }, { suffix: '_indirect', indent: true } ].forEach( ( { suffix, indent } ) => {

		// 1. Apply preprocess directives
		const preprocessed = preprocess( rawCode, {
			INDIRECT: indent,
			INDIRECT_STRING: suffix,
		}, { type: 'js' } );

		// 2. Strip TypeScript types
		const jsCode = stripTypes( preprocessed );

		// 3. Write output
		const outFile = resolve( outputDir, header + suffix + '.generated.ts' );
		writeFileSync( outFile, comment + jsCode + '\n', 'utf8' );
		console.log( `  Written: ${ header }${ suffix }.generated.ts` );

	} );

}

// Main
const tmplFiles = glob.sync( './src/**/*.template.ts' );
console.log( `Processing ${ tmplFiles.length } template files...\n` );

for ( const file of tmplFiles ) {

	console.log( `Template: ${ file.replace( /^\.\/src\//, '' ) }` );
	processTemplate( file );
	console.log( '' );

}

console.log( 'Done.' );

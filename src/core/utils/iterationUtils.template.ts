import { intersectTri } from '../../utils/ThreeRayIntersectUtilities.js';
import { setTriangle } from '../../utils/TriangleUtilities.js';
import type { BufferAttribute, BufferGeometry } from 'three';
import type { ExtendedTriangle } from '../../math/ExtendedTriangle.js';

export function intersectTris/* @echo INDIRECT_STRING */(
	bvh: { geometry: BufferGeometry; _indirectBuffer: Uint32Array | Uint16Array | null },
	materialOrSide: any,
	ray: any,
	offset: number,
	count: number,
	intersections: any[] | null,
	near: number,
	far: number,
): void {

	const { geometry, _indirectBuffer } = bvh;
	for ( let i = offset, end = offset + count; i < end; i ++ ) {

		/* @if INDIRECT */

		const vi = _indirectBuffer ? _indirectBuffer[ i ] : i;
		intersectTri( geometry, materialOrSide, ray, vi, intersections, near, far );

		/* @else */

		intersectTri( geometry, materialOrSide, ray, i, intersections, near, far );

		/* @endif */

	}

}

export function intersectClosestTri/* @echo INDIRECT_STRING */(
	bvh: { geometry: BufferGeometry; _indirectBuffer: Uint32Array | Uint16Array | null },
	materialOrSide: any,
	ray: any,
	offset: number,
	count: number,
	near: number,
	far: number,
): any {

	const { geometry, _indirectBuffer } = bvh;
	let dist = Infinity;
	let res = null;
	for ( let i = offset, end = offset + count; i < end; i ++ ) {

		let intersection;
		/* @if INDIRECT */

		intersection = intersectTri( geometry, materialOrSide, ray, _indirectBuffer ? _indirectBuffer[ i ] : i, null, near, far );

		/* @else */

		intersection = intersectTri( geometry, materialOrSide, ray, i, null, near, far );

		/* @endif */

		if ( intersection && intersection.distance < dist ) {

			res = intersection;
			dist = intersection.distance;

		}

	}

	return res;

}

export function iterateOverTriangles/* @echo INDIRECT_STRING */(
	offset: number,
	count: number,
	bvh: {
		geometry: BufferGeometry;
		resolveTriangleIndex?: ( i: number ) => number;
	},
	intersectsTriangleFunc: ( triangle: ExtendedTriangle, index: number, contained: boolean, depth: number ) => boolean | void,
	contained: boolean,
	depth: number,
	triangle: ExtendedTriangle,
): boolean {

	const { geometry } = bvh;
	const { index } = geometry;
	const pos = geometry.attributes.position as BufferAttribute;
	for ( let i = offset, l = count + offset; i < l; i ++ ) {

		let tri: number;
		/* @if INDIRECT */

		tri = bvh.resolveTriangleIndex!( i );

		/* @else */

		tri = i;

		/* @endif */
		setTriangle( triangle, tri * 3, index, pos );
		triangle.needsUpdate = true;

		if ( intersectsTriangleFunc( triangle, tri, contained, depth ) ) {

			return true;

		}

	}

	return false;

}

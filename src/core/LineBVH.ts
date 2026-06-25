import { Matrix4, Line3, Vector3, Ray, Box3, BufferGeometry, Object3D, Raycaster, Intersection, BufferAttribute } from 'three';
import { PrimitivePool } from '../utils/PrimitivePool.js';
import { INTERSECTED, NOT_INTERSECTED } from './Constants';
import { GeometryBVH, GeometryBVHOptions, PrimitiveRange } from './GeometryBVH';

const _inverseMatrix = /* @__PURE__ */ new Matrix4();
const _ray = /* @__PURE__ */ new Ray();
const _linePool = /* @__PURE__ */ new PrimitivePool( () => new Line3() );
const _intersectPointOnRay = /*@__PURE__*/ new Vector3();
const _intersectPointOnSegment = /*@__PURE__*/ new Vector3();
const _box = /* @__PURE__ */ new Box3();
const _getters = [ 'getX', 'getY', 'getZ' ] as const;

/** Callback invoked for each line segment primitive during `shapecast`. */
export type IntersectsLineCallback = (
	line: Line3,
	index: number,
	contained: boolean,
	depth: number,
) => boolean | void;

/** Callbacks accepted by {@link LineSegmentsBVH.shapecast}. */
export interface LineSegmentsBVHShapecastCallbacks {

	intersectsBounds: (
		box: Box3,
		isLeaf: boolean,
		score: number | undefined,
		depth: number,
		nodeIndex: number,
	) => number | boolean;

	boundsTraverseOrder?: ( box: Box3 ) => number;

	intersectsRange?: (
		offset: number,
		count: number,
		contained: boolean,
		depth: number,
		nodeIndex: number,
		box?: Box3,
	) => boolean;

	intersectsLine?: IntersectsLineCallback;

}

// Internal: a Float32Array carrying an `offset` field used by the build/cast helpers.
type OffsetFloat32Array = Float32Array & { offset?: number };

/**
 * BVH for `THREE.LineSegments` geometries. Each BVH primitive represents one line segment
 * (two consecutive vertices).
 */
export class LineSegmentsBVH extends GeometryBVH {

	override get primitiveStride(): number {

		return 2;

	}

	writePrimitiveBounds( i: number, targetBuffer: OffsetFloat32Array, baseIndex: number ): OffsetFloat32Array {

		const indirectBuffer = this._indirectBuffer;
		const { geometry, primitiveStride } = this;

		const posAttr = geometry.attributes.position as BufferAttribute & { [ key: string ]: ( index: number ) => number };
		const indexAttr = geometry.index;

		// TODO: this may not be right for a LineLoop with a limited draw range / groups
		const vertCount = indexAttr ? indexAttr.count : posAttr.count;

		const prim = indirectBuffer ? indirectBuffer[ i ] : i;
		let i0 = prim * primitiveStride!;
		let i1 = ( i0 + 1 ) % vertCount;
		if ( indexAttr ) {

			i0 = indexAttr.getX( i0 );
			i1 = indexAttr.getX( i1 );

		}

		for ( let el = 0; el < 3; el ++ ) {

			const v0 = posAttr[ _getters[ el ] ]( i0 );
			const v1 = posAttr[ _getters[ el ] ]( i1 );
			const min = v0 < v1 ? v0 : v1;
			const max = v0 > v1 ? v0 : v1;

			// Write in min/max format [minx, miny, minz, maxx, maxy, maxz]
			targetBuffer[ baseIndex + el ] = min;
			targetBuffer[ baseIndex + el + 3 ] = max;

		}

		return targetBuffer;

	}

	/**
	 * Performs a spatial query against the BVH. Extends the base `shapecast` with an
	 * `intersectsLine` callback that is called once per line segment primitive in leaf nodes.
	 *
	 * @param {LineSegmentsBVHShapecastCallbacks} callbacks - The shapecast callbacks.
	 * @returns {boolean} Whether an intersection was found.
	 */
	shapecast( callbacks: LineSegmentsBVHShapecastCallbacks ): boolean {

		const line = _linePool.getPrimitive() as Line3;
		const result = super.shapecast( {
			...callbacks,
			intersectsPrimitive: callbacks.intersectsLine,
			scratchPrimitive: line,
			iterate: iterateOverLines,
		} );
		_linePool.releasePrimitive( line );

		return result;

	}

	/**
	 * @param {Object3D} object - The object to raycast against.
	 * @param {Raycaster} raycaster - The raycaster.
	 * @param {Array<Intersection>} [intersects] - Array to append intersections to.
	 * @returns {Array<Intersection>} The array of intersections.
	 */
	raycastObject3D(
		object: Object3D,
		raycaster: Raycaster,
		intersects: Array<Intersection> = [],
	): Array<Intersection> {

		const { matrixWorld } = object;
		const firstHitOnly = ( raycaster as Raycaster & { firstHitOnly?: boolean } ).firstHitOnly;

		_inverseMatrix.copy( matrixWorld ).invert();
		_ray.copy( raycaster.ray ).applyMatrix4( _inverseMatrix );

		const threshold = raycaster.params.Line.threshold;
		const localThreshold = threshold / ( ( object.scale.x + object.scale.y + object.scale.z ) / 3 );
		const localThresholdSq = localThreshold * localThreshold;

		let closestHit: Intersection | null = null;
		let closestDistance = Infinity;
		this.shapecast( {
			boundsTraverseOrder: box => {

				return box.distanceToPoint( _ray.origin );

			},
			intersectsBounds: box => {

				// TODO: for some reason trying to early-out here is causing firstHitOnly tests to fail
				_box.copy( box ).expandByScalar( Math.abs( localThreshold ) );
				return _ray.intersectsBox( _box ) ? INTERSECTED : NOT_INTERSECTED;

			},
			intersectsLine: ( line, index ) => {

				const distSq = _ray.distanceSqToSegment( line.start, line.end, _intersectPointOnRay, _intersectPointOnSegment );

				if ( distSq > localThresholdSq ) return;

				_intersectPointOnRay.applyMatrix4( object.matrixWorld );

				const distance = raycaster.ray.origin.distanceTo( _intersectPointOnRay );

				if ( distance < raycaster.near || distance > raycaster.far ) return;

				if ( firstHitOnly && distance >= closestDistance ) return;
				closestDistance = distance;

				const resolvedIndex = this.resolvePrimitiveIndex( index );

				closestHit = {
					distance,
					point: _intersectPointOnSegment.clone().applyMatrix4( matrixWorld ),
					index: resolvedIndex * this.primitiveStride!,
					face: null,
					faceIndex: null,
					barycoord: null,
					object,
				};

				if ( ! firstHitOnly ) {

					intersects.push( closestHit );

				}

			},
		} );

		if ( firstHitOnly && closestHit ) {

			intersects.push( closestHit );

		}

		return intersects;

	}

}

/**
 * BVH for `THREE.LineLoop` geometries. Forces indirect mode since the loop structure
 * requires that the index buffer remain unmodified.
 *
 * @param {BufferGeometry} geometry - The line geometry.
 * @param {GeometryBVHOptions} [options] - Same options as {@link GeometryBVH}. `indirect` is always forced to `true`.
 */
export class LineLoopBVH extends LineSegmentsBVH {

	override get primitiveStride(): number {

		return 1;

	}

	constructor( geometry: BufferGeometry, options: GeometryBVHOptions = {} ) {

		// "Line" and "LineLoop" BVH must be indirect since we cannot rearrange the index
		// buffer without breaking the lines
		options = {
			...options,
			indirect: true,
		};

		super( geometry, options );

	}

}

/**
 * BVH for `THREE.Line` geometries. Like `LineLoopBVH` but excludes the final closing
 * segment so the open line is accurately represented.
 *
 * @param {BufferGeometry} geometry - The line geometry.
 * @param {GeometryBVHOptions} [options] - Same options as {@link GeometryBVH}. `indirect` is always forced to `true`.
 */
export class LineBVH extends LineLoopBVH {

	getRootRanges( ...args: Parameters<LineLoopBVH[ 'getRootRanges' ]> ): PrimitiveRange[] {

		const res = super.getRootRanges( ...args );
		res.forEach( group => group.count -- );
		return res;

	}

}

function iterateOverLines(
	offset: number,
	count: number,
	bvh: LineSegmentsBVH,
	intersectsPointFunc: ( line: Line3, index: number, contained: boolean, depth: number ) => boolean | void,
	contained: boolean,
	depth: number,
	line: Line3,
): boolean {

	const { geometry, primitiveStride } = bvh;
	const { index } = geometry;
	const posAttr = geometry.attributes.position as BufferAttribute & { count: number };
	const vertCount = index ? index.count : posAttr.count;

	for ( let i = offset, l = count + offset; i < l; i ++ ) {

		const prim = bvh.resolvePrimitiveIndex( i );
		let i0 = prim * primitiveStride!;
		let i1 = ( i0 + 1 ) % vertCount;
		if ( index ) {

			i0 = index.getX( i0 );
			i1 = index.getX( i1 );

		}

		line.start.fromBufferAttribute( posAttr, i0 );
		line.end.fromBufferAttribute( posAttr, i1 );

		if ( intersectsPointFunc( line, i, contained, depth ) ) {

			return true;

		}

	}

	return false;

}

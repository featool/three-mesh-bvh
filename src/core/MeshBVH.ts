import {
	BufferAttribute,
	FrontSide,
	Ray,
	Vector3,
	Matrix4,
	Box3,
	Sphere,
	BufferGeometry,
	Intersection,
	Material,
	Object3D,
	Raycaster,
	Side,
} from 'three';
import { ExtendedTriangle } from '../math/ExtendedTriangle.js';
import { SKIP_GENERATION, BYTES_PER_NODE, UINT32_PER_NODE, FLOAT32_EPSILON } from './Constants';
import { OrientedBox } from '../math/OrientedBox.js';
import { ExtendedTrianglePool } from '../utils/ExtendedTrianglePool.js';
import { closestPointToPoint } from './cast/closestPointToPoint.js';
import { IS_LEAF } from './utils/nodeBufferUtils.js';

import { iterateOverTriangles } from './utils/iterationUtils.generated.js';
import { refit } from './cast/refit.generated.js';
import { raycast } from './cast/raycast.generated.js';
import { raycastFirst } from './cast/raycastFirst.generated.js';
import { intersectsGeometry } from './cast/intersectsGeometry.generated.js';
import { closestPointToGeometry } from './cast/closestPointToGeometry.generated.js';

import { iterateOverTriangles_indirect } from './utils/iterationUtils_indirect.generated.js';
import { refit_indirect } from './cast/refit_indirect.generated.js';
import { raycast_indirect } from './cast/raycast_indirect.generated.js';
import { raycastFirst_indirect } from './cast/raycastFirst_indirect.generated.js';
import { intersectsGeometry_indirect } from './cast/intersectsGeometry_indirect.generated.js';
import { closestPointToGeometry_indirect } from './cast/closestPointToGeometry_indirect.generated.js';
import { setTriangle } from '../utils/TriangleUtilities.js';
import { convertRaycastIntersect } from '../utils/GeometryRayIntersectUtilities.js';
import { GeometryBVH, GeometryBVHOptions } from './GeometryBVH.js';

const _obb = /* @__PURE__ */ new OrientedBox();
const _ray = /* @__PURE__ */ new Ray();
const _direction = /* @__PURE__ */ new Vector3();
const _inverseMatrix = /* @__PURE__ */ new Matrix4();
const _worldScale = /* @__PURE__ */ new Vector3();
const _getters = [ 'getX', 'getY', 'getZ' ] as const;

/** Callback invoked for each triangle primitive during `shapecast`. */
export type IntersectsTriangleCallback = (
	triangle: ExtendedTriangle,
	triangleIndex: number,
	contained: boolean,
	depth: number,
) => boolean | void;

/** Callback invoked for each pair of triangles during `bvhcast`. */
export type IntersectsTrianglesCallback = (
	triangle1: ExtendedTriangle,
	triangle2: ExtendedTriangle,
	triangleIndex1: number,
	triangleIndex2: number,
	depth1: number,
	nodeIndex1: number,
	depth2: number,
	nodeIndex2: number,
) => boolean;

/**
 * Plain-object representation of a `MeshBVH` produced by `MeshBVH.serialize` and
 * consumed by `MeshBVH.deserialize`. Suitable for transfer across WebWorker boundaries
 * or storage, with optional buffer sharing via `SharedArrayBuffer`.
 */
export interface SerializedBVH {

	version?: number;
	roots: Array<ArrayBuffer>;
	index: Int32Array | Uint32Array | Uint16Array | null;
	indirectBuffer: Uint32Array | Uint16Array | null;

}

/**
 * Information about the closest point found on the mesh surface by
 * `closestPointToPoint` or `closestPointToGeometry`.
 */
export interface HitPointInfo {

	point: Vector3;
	distance: number;
	faceIndex: number;

}

/** Options for {@link MeshBVH.serialize}. */
export interface MeshBVHSerializeOptions {

	cloneBuffers?: boolean;

}

/** Options for {@link MeshBVH.deserialize}. */
export interface MeshBVHDeserializeOptions {

	setIndex?: boolean;
	indirect?: boolean;

}

/** Callbacks accepted by {@link MeshBVH.shapecast}. */
export interface MeshBVHShapecastCallbacks {

	intersectsBounds: (
		box: Box3,
		isLeaf: boolean,
		score: number | undefined,
		depth: number,
		nodeIndex: number,
	) => ShapecastIntersection | boolean;

	boundsTraverseOrder?: ( box: Box3 ) => number;

	intersectsRange?: (
		offset: number,
		count: number,
		contained: boolean,
		depth: number,
		nodeIndex: number,
		box?: Box3,
	) => boolean;

	intersectsTriangle?: IntersectsTriangleCallback;

}

/** Callbacks accepted by {@link MeshBVH.bvhcast}. */
export interface MeshBVHBvhcastCallbacks {

	intersectsRanges?: (
		offset1: number,
		count1: number,
		offset2: number,
		count2: number,
		depth1: number,
		index1: number,
		depth2: number,
		index2: number,
	) => boolean;

	intersectsTriangles?: IntersectsTrianglesCallback;

}

// Re-export the intersection constants so consumers can reference them as a value type.
export const NOT_INTERSECTED = 0 as const;
export const INTERSECTED = 1 as const;
export const CONTAINED = 2 as const;
export type ShapecastIntersection = typeof NOT_INTERSECTED | typeof INTERSECTED | typeof CONTAINED;

// Internal: a Float32Array carrying an `offset` field used by the build/cast helpers.
type OffsetFloat32Array = Float32Array & { offset?: number };

/**
 * The MeshBVH generation process modifies the geometry's index bufferAttribute in place to save
 * memory. The BVH construction will use the geometry's boundingBox if it exists or set it if it
 * does not. The BVH will no longer work correctly if the index buffer is modified.
 *
 * Only triangles within the geometry's draw range (or provided `range` option) are included in the
 * BVH. When a geometry has multiple groups, only triangles within the defined group ranges are
 * included. Triangles in gaps between groups are excluded.
 *
 * Note that all query functions expect arguments in local space of the BVH and return results in
 * local space, as well. If world space results are needed they must be transformed into world space
 * using `object.matrixWorld`.
 */
export class MeshBVH extends GeometryBVH {

	/**
	 * Generates a representation of the complete bounds tree and the geometry index buffer which
	 * can be used to recreate a bounds tree using the `deserialize` function. The `serialize` and
	 * `deserialize` functions can be used to generate a MeshBVH asynchronously in a background web
	 * worker to prevent the main thread from stuttering. The BVH roots buffer stored in the
	 * serialized representation are the same as the ones used by the original BVH so they should
	 * not be modified. If `SharedArrayBuffers` are used then the same BVH memory can be used for
	 * multiple BVH in multiple WebWorkers.
	 *
	 * @param {MeshBVH} bvh - The BVH to serialize.
	 * @param {MeshBVHSerializeOptions} options - Serialization options.
	 * @param {boolean} [options.cloneBuffers] - If `true`, the index and BVH root buffers are cloned so the
	 *   serialized data is independent of the live BVH.
	 * @returns {SerializedBVH} The serialized BVH data.
	 */
	static serialize( bvh: MeshBVH, options: MeshBVHSerializeOptions = {} ): SerializedBVH {

		options = {
			cloneBuffers: true,
			...options,
		};

		const geometry = bvh.geometry;
		const rootData = bvh._roots!;
		const indirectBuffer = bvh._indirectBuffer;
		const indexAttribute = geometry.getIndex();
		const result: SerializedBVH = {
			version: 1,
			roots: null as unknown as ArrayBuffer[],
			index: null,
			indirectBuffer: null,
		};
		if ( options.cloneBuffers ) {

			result.roots = rootData.map( root => root.slice() );
			result.index = indexAttribute ? indexAttribute.array.slice() as Int32Array | Uint32Array | Uint16Array : null;
			result.indirectBuffer = indirectBuffer ? indirectBuffer.slice() as Uint32Array | Uint16Array : null;

		} else {

			result.roots = rootData;
			result.index = indexAttribute ? indexAttribute.array as Int32Array | Uint32Array | Uint16Array : null;
			result.indirectBuffer = indirectBuffer;

		}

		return result;

	}

	/**
	 * Returns a new MeshBVH instance from the serialized data. `geometry` is the geometry used
	 * to generate the original BVH `data` was derived from. The root buffers stored in `data`
	 * are set directly on the new BVH so the memory is shared.
	 *
	 * @param {SerializedBVH} data - Serialized BVH data.
	 * @param {BufferGeometry} geometry - The geometry the BVH was originally built from.
	 * @param {MeshBVHDeserializeOptions} options - Deserialization options.
	 * @param {boolean} [options.setIndex] - If `true`, sets `geometry.index` from the serialized index buffer
	 *   (creating one if none exists).
	 * @returns {MeshBVH} A new MeshBVH instance.
	 */
	static deserialize(
		data: SerializedBVH,
		geometry: BufferGeometry,
		options: MeshBVHDeserializeOptions = {},
	): MeshBVH {

		const resolvedOptions: MeshBVHDeserializeOptions & Record<symbol, unknown> = {
			setIndex: true,
			indirect: Boolean( data.indirectBuffer ),
			...options,
		};

		const { index, roots, indirectBuffer } = data;

		// handle backwards compatibility by fixing up the buffer roots
		// see issue gkjohnson/three-mesh-bvh#759
		if ( ! data.version ) {

			console.warn(
				'MeshBVH.deserialize: Serialization format has been changed and will be fixed up. ' +
				'It is recommended to regenerate any stored serialized data.'
			);
			fixupVersion0( roots );

		}

		const bvh = new MeshBVH( geometry, { ...resolvedOptions, [ SKIP_GENERATION ]: true } as GeometryBVHOptions );
		bvh._roots = roots;
		bvh._indirectBuffer = indirectBuffer || null;

		if ( resolvedOptions.setIndex ) {

			const indexAttribute = geometry.getIndex();
			if ( indexAttribute === null ) {

				const newIndex = new BufferAttribute( index!, 1, false );
				geometry.setIndex( newIndex );

			} else if ( indexAttribute.array !== index ) {

				( indexAttribute.array as Int32Array | Uint32Array | Uint16Array ).set( index! );
				indexAttribute.needsUpdate = true;

			}

		}

		return bvh;

		// convert version 0 serialized data (uint32 indices) to version 1 (node indices)
		/**
		 * @param {ArrayBuffer[]} roots
		 * @returns {void}
		 */
		function fixupVersion0( roots: ArrayBuffer[] ): void {

			for ( let rootIndex = 0; rootIndex < roots.length; rootIndex ++ ) {

				const root = roots[ rootIndex ];
				const uint32Array = new Uint32Array( root );
				const uint16Array = new Uint16Array( root );

				// iterate over nodes and convert right child offsets
				for ( let node = 0, l = root.byteLength / BYTES_PER_NODE; node < l; node ++ ) {

					const node32Index = UINT32_PER_NODE * node;
					const node16Index = 2 * node32Index;
					if ( ! IS_LEAF( node16Index, uint16Array ) ) {

						// convert absolute right child offset to relative offset
						uint32Array[ node32Index + 6 ] = uint32Array[ node32Index + 6 ] / UINT32_PER_NODE - node;

					}

				}

			}

		}

	}

	override get primitiveStride(): number {

		return 3;

	}

	/**
	 * Helper function for use when `indirect` is set to true. This function takes a triangle
	 * index in the BVH layout and returns the associated triangle index in the geometry index
	 * buffer or position attribute.
	 */
	get resolveTriangleIndex(): ( i: number ) => number {

		return this.resolvePrimitiveIndex;

	}

	constructor( geometry: BufferGeometry, options: GeometryBVHOptions = {} ) {

		if ( ( options as { maxLeafTris?: number } ).maxLeafTris ) {

			console.warn( 'MeshBVH: "maxLeafTris" option has been deprecated. Use maxLeafSize, instead.' );
			options = {
				...options,
				maxLeafSize: ( options as { maxLeafTris?: number } ).maxLeafTris,
			};

		}

		super( geometry, options );

	}

	/**
	 * Adjusts all triangle offsets stored in the BVH by the given offset. This is useful when the
	 * triangle data has been compacted or shifted in the geometry buffers (e.g. in `BatchedMesh`
	 * when geometries are compacted using the 'optimize' function or constructing a 'merged' BVH).
	 * This function only adjusts the BVH to point to different triangles in the geometry. The
	 * geometry's index buffer and/or position attributes must be updated separately to match.
	 *
	 * @param {number} offset - The offset to shift triangle indices by.
	 */
	// implement abstract methods from BVH base class
	shiftTriangleOffsets( offset: number ): void {

		return super.shiftPrimitiveOffsets( offset );

	}

	// write primitive bounds to the buffer - used only for validateBounds at the moment
	writePrimitiveBounds( i: number, targetBuffer: OffsetFloat32Array, baseIndex: number ): OffsetFloat32Array {

		const geometry = this.geometry;
		const indirectBuffer = this._indirectBuffer;
		const posAttr = geometry.attributes.position as BufferAttribute & { [ key: string ]: ( index: number ) => number };
		const index = geometry.index ? ( geometry.index.array as Uint32Array | Uint16Array ) : null;

		const tri = indirectBuffer ? indirectBuffer[ i ] : i;
		const tri3 = tri * 3;

		let ai = tri3 + 0;
		let bi = tri3 + 1;
		let ci = tri3 + 2;

		if ( index ) {

			ai = index[ ai ];
			bi = index[ bi ];
			ci = index[ ci ];

		}

		for ( let el = 0; el < 3; el ++ ) {

			const a = posAttr[ _getters[ el ] ]( ai );
			const b = posAttr[ _getters[ el ] ]( bi );
			const c = posAttr[ _getters[ el ] ]( ci );

			let min = a;
			if ( b < min ) min = b;
			if ( c < min ) min = c;

			let max = a;
			if ( b > max ) max = b;
			if ( c > max ) max = c;

			// Write in min/max format [minx, miny, minz, maxx, maxy, maxz]
			targetBuffer[ baseIndex + el ] = min;
			targetBuffer[ baseIndex + el + 3 ] = max;

		}

		return targetBuffer;

	}

	// precomputes the bounding box for each triangle; required for quickly calculating tree splits.
	// result is an array of size count * 6 where triangle i maps to a
	// [x_center, x_delta, y_center, y_delta, z_center, z_delta] tuple starting at index (i - offset) * 6,
	// representing the center and half-extent in each dimension of triangle i
	computePrimitiveBounds(
		offset: number,
		count: number,
		targetBuffer: OffsetFloat32Array,
	): OffsetFloat32Array {

		const geometry = this.geometry;
		const indirectBuffer = this._indirectBuffer;
		const posAttr = geometry.attributes.position as BufferAttribute & {
			normalized: boolean;
			array: ArrayLike<number>;
			offset: number;
			isInterleavedBufferAttribute?: boolean;
			data?: { stride: number };
			[ key: string ]: unknown;
		};
		const index = geometry.index ? ( geometry.index.array as Uint32Array | Uint16Array ) : null;
		const normalized = posAttr.normalized;

		if ( offset < 0 || count + offset - ( targetBuffer.offset || 0 ) > targetBuffer.length / 6 ) {

			throw new Error( 'MeshBVH: compute triangle bounds range is invalid.' );

		}

		// used for non-normalized positions
		const posArr = posAttr.array as ArrayLike<number>;

		// support for an interleaved position buffer
		const bufferOffset = posAttr.offset || 0;
		let stride = 3;
		if ( posAttr.isInterleavedBufferAttribute ) {

			stride = posAttr.data!.stride;

		}

		// used for normalized positions
		const getters = [ 'getX', 'getY', 'getZ' ] as const;
		const writeOffset = targetBuffer.offset || 0;

		// iterate over the triangle range
		for ( let i = offset, l = offset + count; i < l; i ++ ) {

			const tri = indirectBuffer ? indirectBuffer[ i ] : i;
			const tri3 = tri * 3;
			const boundsIndexOffset = ( i - writeOffset ) * 6;

			let ai = tri3 + 0;
			let bi = tri3 + 1;
			let ci = tri3 + 2;

			if ( index ) {

				ai = index[ ai ];
				bi = index[ bi ];
				ci = index[ ci ];

			}

			// we add the stride and offset here since we access the array directly
			// below for the sake of performance
			if ( ! normalized ) {

				ai = ai * stride + bufferOffset;
				bi = bi * stride + bufferOffset;
				ci = ci * stride + bufferOffset;

			}

			for ( let el = 0; el < 3; el ++ ) {

				let a: number, b: number, c: number;

				if ( normalized ) {

					a = ( posAttr[ getters[ el ] ] as ( index: number ) => number )( ai );
					b = ( posAttr[ getters[ el ] ] as ( index: number ) => number )( bi );
					c = ( posAttr[ getters[ el ] ] as ( index: number ) => number )( ci );

				} else {

					a = posArr[ ai + el ];
					b = posArr[ bi + el ];
					c = posArr[ ci + el ];

				}

				let min = a;
				if ( b < min ) min = b;
				if ( c < min ) min = c;

				let max = a;
				if ( b > max ) max = b;
				if ( c > max ) max = c;

				// Increase the bounds size by float32 epsilon to avoid precision errors when
				// converting to 32 bit float. Scale the epsilon by the size of the numbers being
				// worked with.
				const halfExtents = ( max - min ) / 2;
				const el2 = el * 2;
				targetBuffer[ boundsIndexOffset + el2 + 0 ] = min + halfExtents;
				targetBuffer[ boundsIndexOffset + el2 + 1 ] = halfExtents + ( Math.abs( min ) + halfExtents ) * FLOAT32_EPSILON;

			}

		}

		return targetBuffer;

	}

	/**
	 * A convenience function for performing a raycast based on a mesh. Results are formed like
	 * three.js raycast results in world frame.
	 *
	 * @param {Array<Intersection>} [intersects] - Array to append intersections to.
	 * @returns {Array<Intersection>} The array of intersections.
	 */
	raycastObject3D(
		object: Object3D,
		raycaster: Raycaster,
		intersects: Array<Intersection> = [],
	): Array<Intersection> {

		const { material } = object as { material?: Material };
		if ( material === undefined ) {

			return intersects;

		}

		_inverseMatrix.copy( object.matrixWorld ).invert();
		_ray.copy( raycaster.ray ).applyMatrix4( _inverseMatrix );

		_worldScale.setFromMatrixScale( object.matrixWorld );
		_direction.copy( _ray.direction ).multiply( _worldScale );

		const scaleFactor = _direction.length();
		const near = raycaster.near / scaleFactor;
		const far = raycaster.far / scaleFactor;

		if ( ( raycaster as Raycaster & { firstHitOnly?: boolean } ).firstHitOnly === true ) {

			let hit = this.raycastFirst( _ray, material, near, far );
			hit = convertRaycastIntersect( hit, object, raycaster ) as Intersection | null;
			if ( hit ) {

				intersects.push( hit );

			}

		} else {

			const hits = this.raycast( _ray, material, near, far );
			for ( let i = 0, l = hits.length; i < l; i ++ ) {

				const hit = convertRaycastIntersect( hits[ i ], object, raycaster ) as Intersection | null;
				if ( hit ) {

					intersects.push( hit );

				}

			}

		}

		return intersects;

	}

	/**
	 * Refit the node bounds to the current triangle positions. This is quicker than regenerating
	 * a new BVH but will not be optimal after significant changes to the vertices. `nodeIndices`
	 * is a set of node indices (provided by the `shapecast` function) that need to be refit
	 * including all internal nodes.
	 *
	 * @param {Set<number>|Array<number>|null} [nodeIndices] - Optional set of node indices to refit.
	 */
	refit( nodeIndices: Set<number> | Array<number> | null = null ): void {

		const refitFunc = this.indirect ? refit_indirect : refit;
		return refitFunc( this, nodeIndices as unknown as null );

	}

	/* Core Cast Functions */

	/**
	 * Returns all raycast triangle hits in unsorted order. It is expected that `ray` is in the
	 * frame of the BVH already. Likewise the returned results are also provided in the local
	 * frame of the BVH. The `side` identifier is used to determine the side to check when
	 * raycasting or a material with the given side field can be passed. If an array of materials
	 * is provided then it is expected that the geometry has groups and the appropriate material
	 * side is used per group.
	 *
	 * Note that unlike three.js' Raycaster results the points and distances in the intersections
	 * returned from this function are relative to the local frame of the MeshBVH. When using the
	 * `acceleratedRaycast` function as an override for `Mesh.raycast` they are transformed into
	 * world space to be consistent with three's results.
	 *
	 * @param {Ray} ray - The ray to cast.
	 * @param {Side|Material|Array<Material>} [materialOrSide] - The side or material(s) to use.
	 * @param {number} [near] - The near plane distance.
	 * @param {number} [far] - The far plane distance.
	 * @returns {Array<Intersection>} The array of intersections.
	 */
	raycast(
		ray: Ray,
		materialOrSide: Side | Material | Array<Material> = FrontSide,
		near: number = 0,
		far: number = Infinity,
	): Array<Intersection> {

		const roots = this._roots!;
		const intersects: Array<Intersection> = [];
		const raycastFunc = this.indirect ? raycast_indirect : raycast;
		for ( let i = 0, l = roots.length; i < l; i ++ ) {

			raycastFunc( this, i, materialOrSide, ray, intersects, near, far );

		}

		return intersects;

	}

	/**
	 * Returns the first raycast hit in the model. This is typically much faster than returning
	 * all hits. See `raycast` for information on the side and material options as well as the
	 * frame of the returned intersections.
	 *
	 * @param {Ray} ray - The ray to cast.
	 * @param {Side|Material|Array<Material>} [materialOrSide] - The side or material(s) to use.
	 * @param {number} [near] - The near plane distance.
	 * @param {number} [far] - The far plane distance.
	 * @returns {Intersection|null} The first intersection or `null`.
	 */
	raycastFirst(
		ray: Ray,
		materialOrSide: Side | Material | Array<Material> = FrontSide,
		near: number = 0,
		far: number = Infinity,
	): Intersection | null {

		const roots = this._roots!;
		let closestResult: Intersection | null = null;

		const raycastFirstFunc = this.indirect ? raycastFirst_indirect : raycastFirst;
		for ( let i = 0, l = roots.length; i < l; i ++ ) {

			const result = raycastFirstFunc( this, i, materialOrSide, ray, near, far ) as Intersection | null;
			if ( result != null && ( closestResult == null || result.distance < closestResult.distance ) ) {

				closestResult = result;

			}

		}

		return closestResult;

	}

	/**
	 * Returns whether or not the mesh intersects the given geometry.
	 *
	 * The `geometryToBvh` parameter is the transform of the geometry in the BVH's local frame.
	 *
	 * Performance improves considerably if the provided geometry also has a `boundsTree`.
	 *
	 * @param {BufferGeometry} otherGeometry - The geometry to test intersection against.
	 * @param {Matrix4} geomToMesh - Transform of `otherGeometry` into the local space of this BVH.
	 * @returns {boolean} Whether the geometries intersect.
	 */
	intersectsGeometry( otherGeometry: BufferGeometry, geomToMesh: Matrix4 ): boolean {

		let result = false;
		const roots = this._roots!;
		const intersectsGeometryFunc = this.indirect ? intersectsGeometry_indirect : intersectsGeometry;
		for ( let i = 0, l = roots.length; i < l; i ++ ) {

			result = intersectsGeometryFunc( this, i, otherGeometry, geomToMesh );

			if ( result ) {

				break;

			}

		}

		return result;

	}

	/**
	 * A generalized cast function that can be used to implement intersection logic for custom
	 * shapes. This is used internally for `intersectsBox`, `intersectsSphere`, and more. The
	 * function returns as soon as a triangle has been reported as intersected and returns `true`
	 * if a triangle has been intersected.
	 *
	 * @param {MeshBVHShapecastCallbacks} callbacks - The shapecast callbacks.
	 * @returns {boolean} Whether an intersection was found.
	 */
	shapecast( callbacks: MeshBVHShapecastCallbacks ): boolean {

		const triangle = ExtendedTrianglePool.getPrimitive();
		const result = super.shapecast(
			{
				...callbacks,
				intersectsPrimitive: callbacks.intersectsTriangle,
				scratchPrimitive: triangle,

				// TODO: is the performance significant enough for the added complexity here?
				// can we just use one function?
				iterate: this.indirect ? iterateOverTriangles_indirect : iterateOverTriangles,
			}
		);
		ExtendedTrianglePool.releasePrimitive( triangle );

		return result;

	}

	/**
	 * A generalized cast function that traverses two BVH structures simultaneously to perform
	 * intersection tests between them. This is used internally by `intersectsGeometry`. The
	 * function returns `true` as soon as a triangle pair has been reported as intersected by
	 * the callbacks.
	 *
	 * `matrixToLocal` is a Matrix4 that transforms `otherBvh` into the local space of this BVH.
	 * The other BVH's triangles are transformed by this matrix before intersection tests.
	 *
	 * @param {MeshBVH} otherBvh - The other BVH to test against.
	 * @param {Matrix4} matrixToLocal - Transforms `otherBvh` into the local space of this BVH.
	 * @param {MeshBVHBvhcastCallbacks} callbacks - The bvhcast callbacks.
	 * @returns {boolean} Whether an intersection was found.
	 */
	bvhcast(
		otherBvh: MeshBVH,
		matrixToLocal: Matrix4,
		callbacks: MeshBVHBvhcastCallbacks,
	): boolean {

		const { intersectsTriangles } = callbacks;
		let { intersectsRanges } = callbacks;

		const triangle1 = ExtendedTrianglePool.getPrimitive();
		const indexAttr1 = this.geometry.index;
		const positionAttr1 = this.geometry.attributes.position;
		const assignTriangle1 = this.indirect ?
			( i1: number ) => {

				const ti = this.resolveTriangleIndex( i1 );
				setTriangle( triangle1, ti * 3, indexAttr1, positionAttr1 );

			} :
			( i1: number ) => {

				setTriangle( triangle1, i1 * 3, indexAttr1, positionAttr1 );

			};

		const triangle2 = ExtendedTrianglePool.getPrimitive();
		const indexAttr2 = otherBvh.geometry.index;
		const positionAttr2 = otherBvh.geometry.attributes.position;
		const assignTriangle2 = otherBvh.indirect ?
			( i2: number ) => {

				const ti2 = otherBvh.resolveTriangleIndex( i2 );
				setTriangle( triangle2, ti2 * 3, indexAttr2, positionAttr2 );

			} :
			( i2: number ) => {

				setTriangle( triangle2, i2 * 3, indexAttr2, positionAttr2 );

			};

		// generate triangle callback if needed
		if ( intersectsTriangles ) {

			if ( ! ( otherBvh instanceof MeshBVH ) ) {

				throw new Error( 'MeshBVH: "intersectsTriangles" callback can only be used with another MeshBVH.' );

			}

			const iterateOverDoubleTriangles = (
				offset1: number,
				count1: number,
				offset2: number,
				count2: number,
				depth1: number,
				nodeIndex1: number,
				depth2: number,
				nodeIndex2: number,
			): boolean => {

				for ( let i2 = offset2, l2 = offset2 + count2; i2 < l2; i2 ++ ) {

					assignTriangle2( i2 );

					triangle2.a.applyMatrix4( matrixToLocal );
					triangle2.b.applyMatrix4( matrixToLocal );
					triangle2.c.applyMatrix4( matrixToLocal );
					triangle2.needsUpdate = true;

					for ( let i1 = offset1, l1 = offset1 + count1; i1 < l1; i1 ++ ) {

						assignTriangle1( i1 );

						triangle1.needsUpdate = true;

						if ( intersectsTriangles!( triangle1, triangle2, i1, i2, depth1, nodeIndex1, depth2, nodeIndex2 ) ) {

							return true;

						}

					}

				}

				return false;

			};

			if ( intersectsRanges ) {

				const originalIntersectsRanges = intersectsRanges;
				intersectsRanges = function (
					offset1: number,
					count1: number,
					offset2: number,
					count2: number,
					depth1: number,
					nodeIndex1: number,
					depth2: number,
					nodeIndex2: number,
				): boolean {

					if ( ! originalIntersectsRanges!( offset1, count1, offset2, count2, depth1, nodeIndex1, depth2, nodeIndex2 ) ) {

						return iterateOverDoubleTriangles( offset1, count1, offset2, count2, depth1, nodeIndex1, depth2, nodeIndex2 );

					}

					return true;

				};

			} else {

				intersectsRanges = iterateOverDoubleTriangles;

			}

		}

		return super.bvhcast( otherBvh, matrixToLocal, { intersectsRanges: intersectsRanges! } );

	}


	/* Derived Cast Functions */

	/**
	 * Returns whether or not the mesh intersects the given box.
	 *
	 * The `boxToBvh` parameter is the transform of the box in the meshes frame.
	 *
	 * @param {Box3} box - The box to test.
	 * @param {Matrix4} boxToMesh - Transform of the box in the local space of this BVH.
	 * @returns {boolean} Whether the box intersects the mesh.
	 */
	intersectsBox( box: Box3, boxToMesh: Matrix4 ): boolean {

		_obb.set( box.min, box.max, boxToMesh );
		_obb.needsUpdate = true;

		return this.shapecast(
			{
				intersectsBounds: box => _obb.intersectsBox( box ),
				intersectsTriangle: tri => _obb.intersectsTriangle( tri )
			}
		);

	}

	/**
	 * Returns whether or not the mesh intersects the given sphere.
	 *
	 * @param {Sphere} sphere - The sphere to test.
	 * @returns {boolean} Whether the sphere intersects the mesh.
	 */
	intersectsSphere( sphere: Sphere ): boolean {

		return this.shapecast(
			{
				intersectsBounds: box => sphere.intersectsBox( box ),
				intersectsTriangle: tri => tri.intersectsSphere( sphere )
			}
		);

	}

	/**
	 * Computes the closest distance from the geometry to the mesh and puts the closest point on
	 * the mesh in `target1` (in the frame of the BVH) and the closest point on the other
	 * geometry in `target2` (in the geometry frame). If `target1` is not provided a new Object
	 * is created and returned from the function.
	 *
	 * The `geometryToBvh` parameter is the transform of the geometry in the BVH's local frame.
	 *
	 * If a point is found that is closer than `minThreshold` then the function will return that
	 * result early. Any triangles or points outside of `maxThreshold` are ignored. If no point
	 * is found within the min / max thresholds then `null` is returned and the target objects
	 * are not modified.
	 *
	 * The returned faceIndex in `target1` and `target2` can be used with the standalone function
	 * `getTriangleHitPointInfo` to obtain more information like UV coordinates, triangle normal
	 * and materialIndex.
	 *
	 * _Note that this function can be very slow if `geometry` does not have a
	 * `geometry.boundsTree` computed._
	 *
	 * @param {BufferGeometry} otherGeometry - The other geometry.
	 * @param {Matrix4} geometryToBvh - Transform of `otherGeometry` into the local space of this BVH.
	 * @param {HitPointInfo} [target1] - Target for the closest point on this mesh.
	 * @param {HitPointInfo} [target2] - Target for the closest point on the other geometry.
	 * @param {number} [minThreshold] - Minimum distance threshold.
	 * @param {number} [maxThreshold] - Maximum distance threshold.
	 * @returns {HitPointInfo|null} The closest point info or `null`.
	 */
	closestPointToGeometry(
		otherGeometry: BufferGeometry,
		geometryToBvh: Matrix4,
		target1: HitPointInfo = {} as HitPointInfo,
		target2: HitPointInfo = {} as HitPointInfo,
		minThreshold: number = 0,
		maxThreshold: number = Infinity,
	): HitPointInfo | null {

		const closestPointToGeometryFunc = this.indirect ? closestPointToGeometry_indirect : closestPointToGeometry;
		return closestPointToGeometryFunc(
			this,
			otherGeometry,
			geometryToBvh,
			target1,
			target2,
			minThreshold,
			maxThreshold,
		) as HitPointInfo | null;

	}

	/**
	 * Computes the closest distance from the point to the mesh and gives additional information
	 * in `target`. The target can be left undefined to default to a new object which is
	 * ultimately returned by the function.
	 *
	 * If a point is found that is closer than `minThreshold` then the function will return that
	 * result early. Any triangles or points outside of `maxThreshold` are ignored. If no point
	 * is found within the min / max thresholds then `null` is returned and the `target` object
	 * is not modified.
	 *
	 * The returned faceIndex can be used with the standalone function `getTriangleHitPointInfo`
	 * to obtain more information like UV coordinates, triangle normal and materialIndex.
	 *
	 * @param {Vector3} point - The point to measure distance to.
	 * @param {HitPointInfo} [target] - Target object to write results into.
	 * @param {number} [minThreshold] - Minimum distance threshold.
	 * @param {number} [maxThreshold] - Maximum distance threshold.
	 * @returns {HitPointInfo|null} The closest point info or `null`.
	 */
	closestPointToPoint(
		point: Vector3,
		target: HitPointInfo = {} as HitPointInfo,
		minThreshold: number = 0,
		maxThreshold: number = Infinity,
	): HitPointInfo | null {

		return closestPointToPoint(
			this,
			point,
			target,
			minThreshold,
			maxThreshold,
		) as HitPointInfo | null;

	}

}

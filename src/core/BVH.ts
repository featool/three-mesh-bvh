import { Box3, Matrix4 } from 'three';
import { BYTES_PER_NODE, UINT32_PER_NODE, DEFAULT_OPTIONS, FLOAT32_EPSILON } from './Constants';
import { arrayToBox } from '../utils/ArrayBoxUtilities.js';
import { IS_LEAF, LEFT_NODE, RIGHT_NODE, SPLIT_AXIS, COUNT, OFFSET } from './utils/nodeBufferUtils.js';
import { buildPackedTree } from './build/buildTree.js';
import { shapecast as shapecastFunc } from './cast/shapecast.js';
import { bvhcast } from './cast/bvhcast.js';

const _tempBox = /* @__PURE__ */ new Box3();
const _tempBuffer = /* @__PURE__ */ new Float32Array( 6 );

/** Callback for ordering child traversal during `shapecast`. */
export type BoundsTraverseOrderCallback = ( box: Box3 ) => number;

/** Callback for testing shape intersection against a BVH node bounds. */
export type IntersectsBoundsCallback = (
	box: Box3,
	isLeaf: boolean,
	score: number | undefined,
	depth: number,
	nodeIndex: number,
) => number | boolean;

/** Callback for testing intersection against a range of primitives. */
export type IntersectsRangeCallback = (
	offset: number,
	count: number,
	contained: boolean,
	depth: number,
	nodeIndex: number,
	box?: Box3,
) => boolean;

/** Callback for testing intersection between two BVH's primitive ranges. */
export type IntersectsRangesCallback = (
	offset1: number,
	count1: number,
	offset2: number,
	count2: number,
	depth1: number,
	nodeIndex1: number,
	depth2: number,
	nodeIndex2: number,
) => boolean;

/** Callbacks accepted by {@link BVH.shapecast}. */
export interface ShapecastCallbacks {

	intersectsBounds: IntersectsBoundsCallback;
	boundsTraverseOrder?: BoundsTraverseOrderCallback;
	intersectsRange?: IntersectsRangeCallback;

	// Internal fields used by subclasses via super.shapecast()
	intersectsPrimitive?: Function;
	scratchPrimitive?: unknown;
	iterate?: Function;

	// Allow extra properties from subclass-specific callbacks (e.g. intersectsPoint, intersectsLine, etc.)
	[ key: string ]: any;

}

/** Callbacks accepted by {@link BVH.bvhcast}. */
export interface BvhcastCallbacks {

	intersectsRanges: IntersectsRangesCallback;

}

// Internal: a Float32Array carrying an `offset` field used by the build/cast helpers.
type OffsetFloat32Array = Float32Array & { offset?: number };

/**
 * Abstract base class for BVH implementations. Provides core tree traversal and spatial query
 * methods. Subclasses implement primitive-specific logic by overriding `writePrimitiveBounds`
 * and related internal methods.
 */
export class BVH {

	/** Root node buffers of the BVH tree. */
	_roots: ArrayBuffer[];

	/** Indirect primitive index buffer, or null if not in indirect mode. */
	_indirectBuffer: Uint32Array | Uint16Array | null;

	constructor() {

		this._roots = null!;
		this._indirectBuffer = null;

	}

	init( options: Record<string, any> ): void {

		options = {
			...DEFAULT_OPTIONS,
			...options,
		};

		buildPackedTree( this, options );

	}

	/**
	 * @param {{start: number, count: number}|null} [_range]
	 * @returns {Array<{offset: number, count: number}>}
	 */
	getRootRanges( _range?: { start: number; count: number } | null ): Array<{ offset: number; count: number }> {

		// TODO: can we avoid passing range in here?
		throw new Error( 'BVH: getRootRanges() not implemented' );

	}

	// write the i-th primitive bounds in a 6-value min / max format to the buffer
	// starting at the given "writeOffset"
	writePrimitiveBounds( _i: number, _buffer: OffsetFloat32Array, _writeOffset: number ): void {

		throw new Error( 'BVH: writePrimitiveBounds() not implemented' );

	}

	// writes the union bounds of all primitives in the given range in a min / max format
	// to the buffer
	writePrimitiveRangeBounds( offset: number, count: number, targetBuffer: OffsetFloat32Array, baseIndex: number ): OffsetFloat32Array {

		// Initialize bounds
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = - Infinity;
		let maxY = - Infinity;
		let maxZ = - Infinity;

		// compute union of all bounds
		for ( let i = offset, end = offset + count; i < end; i ++ ) {

			this.writePrimitiveBounds( i, _tempBuffer, 0 );

			// compute union
			const [ lx, ly, lz, rx, ry, rz ] = _tempBuffer;
			if ( lx < minX ) minX = lx;
			if ( rx > maxX ) maxX = rx;
			if ( ly < minY ) minY = ly;
			if ( ry > maxY ) maxY = ry;
			if ( lz < minZ ) minZ = lz;
			if ( rz > maxZ ) maxZ = rz;

		}

		// write bounds
		targetBuffer[ baseIndex + 0 ] = minX;
		targetBuffer[ baseIndex + 1 ] = minY;
		targetBuffer[ baseIndex + 2 ] = minZ;
		targetBuffer[ baseIndex + 3 ] = maxX;
		targetBuffer[ baseIndex + 4 ] = maxY;
		targetBuffer[ baseIndex + 5 ] = maxZ;

		return targetBuffer;

	}

	computePrimitiveBounds( offset: number, count: number, targetBuffer: OffsetFloat32Array ): OffsetFloat32Array {

		const boundsOffset = targetBuffer.offset || 0;
		for ( let i = offset, end = offset + count; i < end; i ++ ) {

			this.writePrimitiveBounds( i, _tempBuffer, 0 );

			// construction primitive bounds requires a center + half extents format
			const [ lx, ly, lz, rx, ry, rz ] = _tempBuffer;

			const cx = ( lx + rx ) / 2;
			const cy = ( ly + ry ) / 2;
			const cz = ( lz + rz ) / 2;

			const hx = ( rx - lx ) / 2;
			const hy = ( ry - ly ) / 2;
			const hz = ( rz - lz ) / 2;

			const baseIndex = ( i - boundsOffset ) * 6;
			targetBuffer[ baseIndex + 0 ] = cx;
			targetBuffer[ baseIndex + 1 ] = hx + ( Math.abs( cx ) + hx ) * FLOAT32_EPSILON;
			targetBuffer[ baseIndex + 2 ] = cy;
			targetBuffer[ baseIndex + 3 ] = hy + ( Math.abs( cy ) + hy ) * FLOAT32_EPSILON;
			targetBuffer[ baseIndex + 4 ] = cz;
			targetBuffer[ baseIndex + 5 ] = hz + ( Math.abs( cz ) + hz ) * FLOAT32_EPSILON;

		}

		return targetBuffer;

	}

	/**
	 * Adjusts all primitive offsets stored in the BVH leaf nodes by the given value. Useful when
	 * geometry buffers have been shifted or compacted (e.g. when merging geometries).
	 * @param {number} offset
	 */
	shiftPrimitiveOffsets( offset: number ): void {

		const indirectBuffer = this._indirectBuffer;
		if ( indirectBuffer ) {

			// the offsets are embedded in the indirect buffer
			for ( let i = 0, l = indirectBuffer.length; i < l; i ++ ) {

				indirectBuffer[ i ] += offset;

			}

		} else {

			// offsets are embedded in the leaf nodes
			const roots = this._roots;
			for ( let rootIndex = 0; rootIndex < roots.length; rootIndex ++ ) {

				const root = roots[ rootIndex ];
				const uint32Array = new Uint32Array( root );
				const uint16Array = new Uint16Array( root );
				const totalNodes = root.byteLength / BYTES_PER_NODE;
				for ( let node = 0; node < totalNodes; node ++ ) {

					const node32Index = UINT32_PER_NODE * node;
					const node16Index = 2 * node32Index;
					if ( IS_LEAF( node16Index, uint16Array ) ) {

						// offset value
						uint32Array[ node32Index + 6 ] += offset;

					}

				}

			}

		}

	}

	/**
	 * Traverses all nodes of the BVH, invoking a callback for each node.
	 *
	 * For leaf nodes the callback receives `( depth, isLeaf, boundingData, offset, count )`.
	 * For internal nodes it receives `( depth, isLeaf, boundingData, splitAxis )` and may
	 * return `true` to stop descending into that node's children.
	 *
	 * @param {Function} callback
	 * @param {number} [rootIndex=0]
	 */
	traverse(
		callback: (
			depth: number,
			isLeaf: boolean,
			boundingData: Float32Array,
			offsetOrSplit: number,
			count?: number,
		) => boolean | void,
		rootIndex: number = 0,
	): void {

		const buffer = this._roots[ rootIndex ];
		const uint32Array = new Uint32Array( buffer );
		const uint16Array = new Uint16Array( buffer );
		_traverse( 0 );

		function _traverse( node32Index: number, depth: number = 0 ): void {

			const node16Index = node32Index * 2;
			const isLeaf = IS_LEAF( node16Index, uint16Array );
			if ( isLeaf ) {

				const offset = uint32Array[ node32Index + 6 ];
				const count = uint16Array[ node16Index + 14 ];
				callback( depth, isLeaf, new Float32Array( buffer, node32Index * 4, 6 ), offset, count );

			} else {

				const left = LEFT_NODE( node32Index );
				const right = RIGHT_NODE( node32Index, uint32Array );
				const splitAxis = SPLIT_AXIS( node32Index, uint32Array );
				const stopTraversal = callback( depth, isLeaf, new Float32Array( buffer, node32Index * 4, 6 ), splitAxis );

				if ( ! stopTraversal ) {

					_traverse( left, depth + 1 );
					_traverse( right, depth + 1 );

				}

			}

		}

	}

	/**
	 * Refits all BVH node bounds to reflect the current primitive positions. Faster than
	 * rebuilding the BVH but produces a less optimal tree after large vertex deformations.
	 */
	refit( /* nodeIndices = null */ ): void {

		// TODO: add support for "nodeIndices"
		// if ( nodeIndices && Array.isArray( nodeIndices ) ) {

		// 	nodeIndices = new Set( nodeIndices );

		// }

		const roots = this._roots;
		for ( let rootIndex = 0, rootCount = roots.length; rootIndex < rootCount; rootIndex ++ ) {

			const buffer = roots[ rootIndex ];
			const uint32Array = new Uint32Array( buffer );
			const uint16Array = new Uint16Array( buffer );
			const float32Array = new Float32Array( buffer );
			const totalNodes = buffer.byteLength / BYTES_PER_NODE;

			// Traverse nodes from right to left so children are updated before parents
			for ( let nodeIndex = totalNodes - 1; nodeIndex >= 0; nodeIndex -- ) {

				const nodeIndex32 = nodeIndex * UINT32_PER_NODE;
				const nodeIndex16 = nodeIndex32 * 2;
				const isLeaf = IS_LEAF( nodeIndex16, uint16Array );

				if ( isLeaf ) {

					// get the bounds
					const offset = OFFSET( nodeIndex32, uint32Array );
					const count = COUNT( nodeIndex16, uint16Array );
					this.writePrimitiveRangeBounds( offset, count, _tempBuffer, 0 );

					// write directly to node bounds (already in min/max format)
					float32Array.set( _tempBuffer, nodeIndex32 );

				} else {

					const left = LEFT_NODE( nodeIndex32 );
					const right = RIGHT_NODE( nodeIndex32, uint32Array );

					// Union the bounds of left and right children
					for ( let i = 0; i < 3; i ++ ) {

						const leftMin = float32Array[ left + i ];
						const leftMax = float32Array[ left + i + 3 ];
						const rightMin = float32Array[ right + i ];
						const rightMax = float32Array[ right + i + 3 ];

						float32Array[ nodeIndex32 + i ] = leftMin < rightMin ? leftMin : rightMin;
						float32Array[ nodeIndex32 + i + 3 ] = leftMax > rightMax ? leftMax : rightMax;

					}

				}

			}

		}

	}

	/**
	 * Computes the axis-aligned bounding box of all primitives in the BVH.
	 * @param {Box3} target - Target box to write the result into.
	 * @returns {Box3}
	 */
	getBoundingBox( target: Box3 ): Box3 {

		target.makeEmpty();

		const roots = this._roots;
		roots.forEach( buffer => {

			arrayToBox( 0, new Float32Array( buffer ), _tempBox );
			target.union( _tempBox );

		} );

		return target;

	}

	/**
	 * A generalized traversal function for performing spatial queries against the BVH. Returns
	 * `true` as soon as a primitive has been reported as intersected. The tree is traversed
	 * depth-first; `boundsTraverseOrder` controls which child is visited first. Returning
	 * `CONTAINED` from `intersectsBounds` skips further child traversal and intersects all
	 * primitives in that subtree immediately.
	 *
	 * @param {ShapecastCallbacks} callbacks
	 * @returns {boolean}
	 */
	// TODO: see if we can get rid of "iterateFunc" here as well as the primitive so the function
	// API aligns with the "shapecast" implementation
	shapecast( callbacks: ShapecastCallbacks ): boolean {

		// TODO: can we get rid of "scratchPrimitive" and / or "iterate"? Or merge them somehow
		let {
			boundsTraverseOrder,
			intersectsBounds,
			intersectsRange,
			intersectsPrimitive,
			scratchPrimitive,
			iterate,
		} = callbacks;

		// wrap the intersectsRange function
		if ( intersectsRange && intersectsPrimitive ) {

			const originalIntersectsRange = intersectsRange;
			intersectsRange = ( offset, count, contained, depth, nodeIndex ) => {

				if ( ! originalIntersectsRange( offset, count, contained, depth, nodeIndex ) ) {

					return iterate!( offset, count, this, intersectsPrimitive, contained, depth, scratchPrimitive );

				}

				return true;

			};

		} else if ( ! intersectsRange ) {

			if ( intersectsPrimitive ) {

				intersectsRange = ( offset, count, contained, depth ) => {

					return iterate!( offset, count, this, intersectsPrimitive, contained, depth, scratchPrimitive );

				};

			} else {

				intersectsRange = ( _offset, _count, contained ) => {

					return contained;

				};

			}

		}

		// run shapecast
		let result = false;
		let nodeOffset = 0;
		const roots = this._roots;
		for ( let i = 0, l = roots.length; i < l; i ++ ) {

			const root = roots[ i ];
			result = shapecastFunc( this, i, intersectsBounds, intersectsRange, boundsTraverseOrder, nodeOffset );

			if ( result ) {

				break;

			}

			nodeOffset += root.byteLength / BYTES_PER_NODE;

		}

		return result;

	}

	/**
	 * Simultaneously traverses two BVH structures to find intersecting primitive pairs. Returns
	 * `true` as soon as any intersection is reported. Both trees are traversed depth-first with
	 * alternating descent. `matrixToLocal` transforms `otherBvh` into the local space of this BVH.
	 *
	 * @param {BVH} otherBvh
	 * @param {Matrix4} matrixToLocal
	 * @param {BvhcastCallbacks} callbacks
	 * @returns {boolean}
	 */
	bvhcast( otherBvh: BVH, matrixToLocal: Matrix4, callbacks: BvhcastCallbacks ): boolean {

		let { intersectsRanges } = callbacks;
		return bvhcast( this, otherBvh, matrixToLocal, intersectsRanges );

	}

}

// Declare properties that subclasses (GeometryBVH, ObjectBVH) define as getters/setters.
// These are used by buildTree.js which reads bvh.primitiveBuffer / bvh.primitiveBufferStride.
( BVH.prototype as unknown as Record<string, unknown> ).primitiveBuffer = null;
( BVH.prototype as unknown as Record<string, unknown> ).primitiveBufferStride = null;

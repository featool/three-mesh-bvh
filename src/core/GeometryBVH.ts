import { Box3, BufferGeometry, Object3D, Raycaster, Intersection } from 'three';
import { SKIP_GENERATION, DEFAULT_OPTIONS } from './Constants';
import { isSharedArrayBufferSupported } from '../utils/BufferUtils.js';
import { ensureIndex, getRootPrimitiveRanges } from './build/geometryUtils.js';
import { BVH } from './BVH.js';

/** Represents a contiguous range of primitives in a geometry buffer. */
export interface PrimitiveRange {

	offset: number;
	count: number;

}

/** Options for constructing a {@link GeometryBVH}. */
export interface GeometryBVHOptions {

	/** Split strategy: `CENTER`, `AVERAGE`, or `SAH`. */
	strategy?: number;
	/** Maximum tree depth. */
	maxDepth?: number;
	/** Maximum primitives per leaf node. */
	maxLeafSize?: number;
	/** Set `geometry.boundingBox` if not already present. */
	setBoundingBox?: boolean;
	/** Use `SharedArrayBuffer` for BVH root buffers. */
	useSharedArrayBuffer?: boolean;
	/** Build using an indirect buffer, leaving the original index unmodified. */
	indirect?: boolean;
	/** Log build progress to the console. */
	verbose?: boolean;
	/** Called with a progress value in [0, 1] during build. */
	onProgress?: ( ( progress: number ) => void ) | null;
	/** Restrict the BVH to a specific geometry group range. */
	range?: { start: number; count: number } | null;

}

interface BuildOptions {

	strategy: number;
	maxDepth: number;
	maxLeafSize: number;
	setBoundingBox: boolean;
	useSharedArrayBuffer: boolean;
	indirect: boolean;
	verbose: boolean;
	onProgress: ( ( progress: number ) => void ) | null;
	range: { start: number; count: number } | null;

}

// construct a new buffer that points to the set of triangles represented by the given ranges
export function generateIndirectBuffer(
	ranges: PrimitiveRange[],
	useSharedArrayBuffer: boolean,
): Uint32Array | Uint16Array {

	const lastRange = ranges[ ranges.length - 1 ];
	const useUint32 = lastRange.offset + lastRange.count > 2 ** 16;

	// use getRootIndexRanges which excludes gaps
	const length = ranges.reduce( ( acc, val ) => acc + val.count, 0 );
	const byteCount = useUint32 ? 4 : 2;
	const buffer = useSharedArrayBuffer
		? new SharedArrayBuffer( length * byteCount )
		: new ArrayBuffer( length * byteCount );
	const indirectBuffer = useUint32
		? new Uint32Array( buffer )
		: new Uint16Array( buffer );

	// construct a compact form of the triangles in these ranges
	let index = 0;
	for ( let r = 0; r < ranges.length; r ++ ) {

		const { offset, count } = ranges[ r ];
		for ( let i = 0; i < count; i ++ ) {

			indirectBuffer[ index + i ] = offset + i;

		}

		index += count;

	}

	return indirectBuffer;

}

/**
 * Abstract base class for geometry-backed BVH implementations. Handles geometry
 * indexing, indirect mode, and bounding box initialization. Subclasses implement
 * primitive-specific bounds computation and raycasting via `writePrimitiveBounds`
 * and `raycastObject3D`.
 */
export class GeometryBVH extends BVH {

	/** The geometry this BVH was built from. */
	readonly geometry: BufferGeometry;

	/** Whether the BVH was built in indirect mode. */
	get indirect(): boolean {

		return ! ! this._indirectBuffer;

	}

	get primitiveStride(): number | null {

		return null;

	}

	get primitiveBufferStride(): number | null {

		return this.indirect ? 1 : this.primitiveStride;

	}
	set primitiveBufferStride( _v: unknown ) {}

	get primitiveBuffer(): Uint32Array | Uint16Array {

		return this.indirect
			? this._indirectBuffer!
			: this.geometry.index!.array as Uint32Array | Uint16Array;

	}
	set primitiveBuffer( _v: unknown ) {}

	/**
	 * Resolves a BVH primitive index to the corresponding index in the geometry's
	 * index buffer or position attribute.
	 */
	resolvePrimitiveIndex: ( i: number ) => number;

	/** @internal Indirect primitive index buffer, or `null` if not in indirect mode. */
	_indirectBuffer: Uint32Array | Uint16Array | null;

	constructor( geometry: BufferGeometry, options: GeometryBVHOptions = {} ) {

		if ( ! geometry.isBufferGeometry ) {

			throw new Error( 'BVH: Only BufferGeometries are supported.' );

		} else if ( geometry.index && ( geometry.index as { isInterleavedBufferAttribute?: boolean } ).isInterleavedBufferAttribute ) {

			throw new Error( 'BVH: InterleavedBufferAttribute is not supported for the index attribute.' );

		}

		if ( options.useSharedArrayBuffer && ! isSharedArrayBufferSupported() ) {

			throw new Error( 'BVH: SharedArrayBuffer is not available.' );

		}

		super();

		// retain references to the geometry so we can use them without having to
		// take a geometry reference in every function.
		this.geometry = geometry;
		this.resolvePrimitiveIndex = options.indirect
			? ( i: number ): number => this._indirectBuffer![ i ]
			: ( i: number ): number => i;
		this.primitiveBuffer = null;
		this.primitiveBufferStride = null;
		this._indirectBuffer = null;

		const resolvedOptions = {
			...DEFAULT_OPTIONS,
			...options,
		} as BuildOptions;

		// build the BVH unless we're deserializing
		if ( ! ( resolvedOptions as unknown as Record<symbol, unknown> )[ SKIP_GENERATION ] ) {

			this.init( resolvedOptions );

		}

	}

	init( options: BuildOptions ): void {

		const { geometry, primitiveStride } = this;

		if ( options.indirect ) {

			// construct a buffer that indirectly sorts the triangles used for the BVH
			const ranges = getRootPrimitiveRanges( geometry, options.range, primitiveStride ) as PrimitiveRange[];
			const indirectBuffer = generateIndirectBuffer( ranges, options.useSharedArrayBuffer );
			this._indirectBuffer = indirectBuffer;

		} else {

			ensureIndex( geometry, options );

		}

		super.init( options );

		if ( ! geometry.boundingBox && options.setBoundingBox ) {

			geometry.boundingBox = this.getBoundingBox( new Box3() );

		}

	}

	// Abstract methods to be implemented by subclasses
	getRootRanges( range?: { start: number; count: number } | null ): PrimitiveRange[] {

		// TODO: can we avoid passing options in here
		if ( this.indirect ) {

			return [ { offset: 0, count: this._indirectBuffer!.length } ];

		} else {

			return getRootPrimitiveRanges( this.geometry, range, this.primitiveStride ) as PrimitiveRange[];

		}

	}

	raycastObject3D(
		_object: Object3D,
		_raycaster: Raycaster,
		_intersects: Array<Intersection>,
	): void {

		throw new Error( 'BVH: raycastObject3D() not implemented' );

	}

}

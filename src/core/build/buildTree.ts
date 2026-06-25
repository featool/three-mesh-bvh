import { getBounds } from './computeBoundsUtils.js';
import { getOptimalSplit } from './splitUtils.js';
import { BVHNode } from '../BVHNode';
import { BYTES_PER_NODE } from '../Constants';

import { partition } from './sortUtils.js';
import { countNodes, populateBuffer } from './buildUtils.js';

type OffsetFloat32Array = Float32Array & { offset?: number };

interface BuildSplit {
	axis: number;
	pos: number;
}

interface BuildOptions {
	maxDepth: number;
	verbose: boolean;
	maxLeafSize: number;
	strategy: number;
	onProgress: (( progress: number ) => void) | null;
	range?: { start: number; count: number };
	useSharedArrayBuffer?: boolean;
}

interface LoadRange {
	offset: number;
	count: number;
}

interface BVHLike {
	primitiveBuffer: Uint32Array | Uint16Array | null;
	primitiveBufferStride: number | null;
	computePrimitiveBounds( offset: number, count: number, targetBuffer: OffsetFloat32Array ): OffsetFloat32Array;
	_roots: ArrayBuffer[];
	getRootRanges( range?: { start: number; count: number } | null ): Array<{ offset: number; count: number }>;
}

export function buildTree( bvh: BVHLike, primitiveBounds: OffsetFloat32Array, offset: number, count: number, options: BuildOptions, loadRange: LoadRange ): BVHNode {

	// expand variables
	const {
		maxDepth,
		verbose,
		maxLeafSize,
		strategy,
		onProgress,
	} = options;

	const partitionBuffer = bvh.primitiveBuffer!;
	const partitionStride = bvh.primitiveBufferStride || 1;

	// generate intermediate variables
	const cacheCentroidBoundingData = new Float32Array( 6 );
	let reachedMaxDepth = false;

	const root = new BVHNode();
	getBounds( primitiveBounds, offset, count, root.boundingData, cacheCentroidBoundingData );
	splitNode( root, offset, count, cacheCentroidBoundingData );
	return root;

	function triggerProgress( primitivesProcessed: number ): void {

		if ( onProgress ) {

			onProgress( ( primitivesProcessed - loadRange.offset ) / loadRange.count );

		}

	}

	// either recursively splits the given node, creating left and right subtrees for it, or makes it a leaf node,
	// recording the offset and count of its primitives and writing them into the reordered geometry index.
	function splitNode( node: BVHNode, offset: number, count: number, centroidBoundingData: Float32Array | null = null, depth: number = 0 ): BVHNode {

		if ( ! reachedMaxDepth && depth >= maxDepth ) {

			reachedMaxDepth = true;
			if ( verbose ) {

				console.warn( `BVH: Max depth of ${ maxDepth } reached when generating BVH. Consider increasing maxDepth.` );

			}

		}

		// early out if we've met our capacity
		if ( count <= maxLeafSize || depth >= maxDepth ) {

			triggerProgress( offset + count );
			node.offset = offset;
			node.count = count;
			return node;

		}

		// Find where to split the volume
		const split = getOptimalSplit( node.boundingData, centroidBoundingData!, primitiveBounds, offset, count, strategy ) as BuildSplit;
		if ( split.axis === - 1 ) {

			triggerProgress( offset + count );
			node.offset = offset;
			node.count = count;
			return node;

		}

		const splitOffset = partition( partitionBuffer, partitionStride, primitiveBounds, offset, count, split );

		// create the two new child nodes
		if ( splitOffset === offset || splitOffset === offset + count ) {

			triggerProgress( offset + count );
			node.offset = offset;
			node.count = count;

		} else {

			node.splitAxis = split.axis;

			// create the left child and compute its bounding box
			const left = new BVHNode();
			const lstart = offset;
			const lcount = splitOffset - offset;
			node.left = left;

			getBounds( primitiveBounds, lstart, lcount, left.boundingData, cacheCentroidBoundingData );
			splitNode( left, lstart, lcount, cacheCentroidBoundingData, depth + 1 );

			// repeat for right
			const right = new BVHNode();
			const rstart = splitOffset;
			const rcount = count - lcount;
			node.right = right;

			getBounds( primitiveBounds, rstart, rcount, right.boundingData, cacheCentroidBoundingData );
			splitNode( right, rstart, rcount, cacheCentroidBoundingData, depth + 1 );

		}

		return node;

	}

}

export function buildPackedTree( bvh: BVHLike, options: BuildOptions & Record<string, unknown> ): void {

	const BufferConstructor = ( options.useSharedArrayBuffer as boolean | undefined ) ? SharedArrayBuffer : ArrayBuffer;

	// get the range of buffer data to construct / arrange
	const rootRanges = bvh.getRootRanges( options.range as { start: number; count: number } | null | undefined );
	const firstRange = rootRanges[ 0 ];
	const lastRange = rootRanges[ rootRanges.length - 1 ];
	const fullRange: LoadRange = {
		offset: firstRange.offset,
		count: lastRange.offset + lastRange.count - firstRange.offset,
	};

	// construct the primitive bounds for sorting
	const primitiveBounds = new Float32Array( 6 * fullRange.count ) as OffsetFloat32Array;
	primitiveBounds.offset = fullRange.offset;
	bvh.computePrimitiveBounds( fullRange.offset, fullRange.count, primitiveBounds );

	// Build BVH roots
	bvh._roots = rootRanges.map( ( range: { offset: number; count: number } ) => {

		const root = buildTree( bvh, primitiveBounds, range.offset, range.count, options as BuildOptions, fullRange );
		const nodeCount = countNodes( root );
		const buffer = new BufferConstructor( BYTES_PER_NODE * nodeCount );
		populateBuffer( 0, root, buffer );
		return buffer;

	} );

}

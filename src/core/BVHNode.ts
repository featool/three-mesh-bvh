/**
 * Intermediate node structure used during BVH construction.
 *
 * Internal nodes have `boundingData`, `left`, `right`, and `splitAxis`.
 * Leaf nodes have `offset` and `count` (referring to primitives in the mesh geometry),
 * and optionally `buffer`.
 */
export class BVHNode {

	/** Min/max bounding box data in `[minX, minY, minZ, maxX, maxY, maxZ]` format. */
	boundingData: Float32Array;

	/** Offset into the primitive buffer (leaf nodes only). */
	offset?: number;

	/** Number of primitives in this leaf node (leaf nodes only). */
	count?: number;

	/** Axis (0=x, 1=y, 2=z) used to split this internal node. */
	splitAxis?: number;

	/** Left child node (internal nodes only). */
	left?: BVHNode;

	/** Right child node (internal nodes only). */
	right?: BVHNode;

	/** Pre-packed node buffer (leaf nodes only, used for direct copy during serialization). */
	buffer?: ArrayBuffer;

	constructor() {

		this.boundingData = new Float32Array( 6 );

	}

}

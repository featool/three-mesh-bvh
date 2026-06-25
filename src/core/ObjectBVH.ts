import {
	Box3,
	BufferGeometry,
	BufferAttribute,
	Matrix4,
	Mesh,
	Vector3,
	Ray,
	Sphere,
	Object3D,
	Raycaster,
	Intersection,
	Material,
	InstancedMesh,
	BatchedMesh,
} from 'three';
import { BVH } from './BVH.js';
import { INTERSECTED, NOT_INTERSECTED, BVHOptions } from './Constants';

const _geometry = /* @__PURE__ */ new BufferGeometry();
const _matrix = /* @__PURE__ */ new Matrix4();
const _inverseMatrix = /* @__PURE__ */ new Matrix4();
const _box = /* @__PURE__ */ new Box3();
const _sphere = /* @__PURE__ */ new Sphere();
const _vec = /* @__PURE__ */ new Vector3();
const _ray = /* @__PURE__ */ new Ray();
const _mesh = /* @__PURE__ */ new Mesh();
const _geometryRange = { start: 0, count: 0 } as { start: number; count: number };

/** Callback invoked for each object primitive during `shapecast`. */
export type IntersectsObjectCallback = (
	object: Object3D,
	instanceId: number,
	contained: boolean,
	depth: number,
) => boolean | void;

/** Options for constructing an {@link ObjectBVH}. */
export interface ObjectBVHOptions {

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
	onProgress?: ((progress: number) => void) | null;
	/** Restrict the BVH to a specific geometry group range. */
	range?: { start: number; count: number } | null;
	/** Use vertex-level bounds instead of cached bounding boxes. */
	precise?: boolean;
	/** Treat each instance of InstancedMesh/BatchedMesh as a separate primitive. */
	includeInstances?: boolean;
	/** The world matrix for the BVH root. */
	matrixWorld?: Matrix4;

}

/** Callbacks accepted by {@link ObjectBVH.shapecast}. */
export interface ObjectBVHShapecastCallbacks {

	intersectsBounds: (
		box: Box3,
		isLeaf: boolean,
		score: number | undefined,
		depth: number,
		nodeIndex: number,
	) => number | boolean;

	boundsTraverseOrder?: (box: Box3) => number;

	intersectsRange?: (
		offset: number,
		count: number,
		contained: boolean,
		depth: number,
		nodeIndex: number,
		box: Box3,
	) => boolean;

	intersectsObject?: IntersectsObjectCallback;

}

// Internal resolved options after merging with defaults
interface ResolvedObjectBVHOptions extends BVHOptions {

	precise: boolean;
	includeInstances: boolean;
	matrixWorld: Matrix4;

}

// Internal: a Float32Array carrying an `offset` field used by the build/cast helpers.
type OffsetFloat32Array = Float32Array & { offset?: number };

/**
 * BVH built from a scene hierarchy rather than a single geometry. Each leaf holds
 * one Object3D (or one instance of an InstancedMesh/BatchedMesh), enabling
 * accelerated raycasting and spatial queries across many objects at once.
 */
export class ObjectBVH extends BVH {

	/** Collected leaf objects (Mesh, Line, Points, InstancedMesh, BatchedMesh). */
	objects: Object3D[];
	/** Number of bits used for the object id in the composite id. */
	idBits: number;
	/** Bit mask for extracting the object id from a composite id. */
	idMask: number;
	/** Buffer mapping BVH primitive indices to composite ids. */
	primitiveBuffer: Uint32Array | null;
	/** Stride of the primitive buffer (always 1 for ObjectBVH). */
	primitiveBufferStride: number;
	/** Whether to use vertex-level bounds instead of cached bounding boxes. */
	precise: boolean;
	/** Whether to treat each instance of InstancedMesh/BatchedMesh as a separate primitive. */
	includeInstances: boolean;
	/** The world matrix for the BVH root. */
	matrixWorld: Matrix4;

	constructor(root: Object3D | Object3D[], options: ObjectBVHOptions = {}) {

		const resolvedOptions = {
			precise: false,
			includeInstances: true,
			matrixWorld: Array.isArray(root) ? new Matrix4() : root.matrixWorld,
			maxLeafSize: 1,
			...options,
		};

		super();

		// collect all the leaf node objects in the geometries
		const objectSet = new Set<Object3D>();
		collectObjects(root, objectSet);

		// calculate the number of bits required for the primary id, leaving the remainder
		// for the instanceId count
		const objects = Array.from(objectSet);
		const idBits = Math.ceil(Math.log2(objects.length));
		const idMask = constructIdMask(idBits);

		this.objects = objects;
		this.idBits = idBits;
		this.idMask = idMask;
		this.primitiveBuffer = null;
		this.primitiveBufferStride = 1;

		// settings
		this.precise = resolvedOptions.precise;
		this.includeInstances = resolvedOptions.includeInstances;
		this.matrixWorld = resolvedOptions.matrixWorld;

		this.init(resolvedOptions as ResolvedObjectBVHOptions);

	}

	/**
	 * Returns the `Object3D` associated with a composite id as provided to `intersectsObject`.
	 * @param {number} compositeId
	 * @returns {Object3D}
	 */
	getObjectFromId(compositeId: number): Object3D {

		const { idMask, objects } = this;
		const id = getObjectId(compositeId, idMask);
		return objects[ id ];

	}

	/**
	 * Returns the instance index associated with a composite id as provided to `intersectsObject`.
	 * @param {number} compositeId
	 * @returns {number}
	 */
	getInstanceFromId(compositeId: number): number {

		const { idMask, idBits } = this;
		return getInstanceId(compositeId, idBits, idMask);

	}

	init(options: ResolvedObjectBVHOptions): void {

		const { objects, idBits } = this;
		this.primitiveBuffer = new Uint32Array(this._countPrimitives(objects));
		this._fillPrimitiveBuffer(objects, idBits, this.primitiveBuffer);

		super.init(options);

	}

	writePrimitiveBounds(i: number, targetBuffer: OffsetFloat32Array, writeOffset: number): void {

		// TODO: it would be best to cache this matrix inversion
		const { primitiveBuffer } = this;
		_inverseMatrix.copy(this.matrixWorld).invert();

		this._getPrimitiveBoundingBox(primitiveBuffer![ i ], _inverseMatrix, _box);
		const { min, max } = _box;

		targetBuffer[ writeOffset + 0 ] = min.x;
		targetBuffer[ writeOffset + 1 ] = min.y;
		targetBuffer[ writeOffset + 2 ] = min.z;
		targetBuffer[ writeOffset + 3 ] = max.x;
		targetBuffer[ writeOffset + 4 ] = max.y;
		targetBuffer[ writeOffset + 5 ] = max.z;

	}

	getRootRanges(): Array<{ offset: number; count: number }> {

		return [ { offset: 0, count: this.primitiveBuffer!.length } ];

	}

	/**
	 * Performs a spatial query against the BVH. Extends the base `shapecast` with an
	 * `intersectsObject` callback that is called once per object primitive in leaf nodes.
	 *
	 * @param {ObjectBVHShapecastCallbacks} callbacks - The shapecast callbacks.
	 * @returns {boolean} Whether an intersection was found.
	 */
	shapecast(callbacks: ObjectBVHShapecastCallbacks): boolean {

		return super.shapecast({
			...callbacks,

			intersectsPrimitive: callbacks.intersectsObject,
			scratchPrimitive: null,
			iterate: iterateOverObjects,
		});

	}

	// TODO: this is out of sync with the MeshBVH raycast signature.
	// Change this to "raycastObject3D"? Or add an equivalent?
	raycast(
		raycaster: Raycaster,
		intersects: Array<Intersection> = [],
	): Array<Intersection> {

		const { matrixWorld, includeInstances } = this;
		const firstHitOnly = (raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly;
		const localIntersects: Array<Intersection> = [];

		// transform the ray into the local bvh frame
		_inverseMatrix.copy(matrixWorld).invert();
		_ray.copy(raycaster.ray).applyMatrix4(_inverseMatrix);

		let closestDistance = Infinity;
		let closestHit: Intersection | null = null;

		this.shapecast({
			boundsTraverseOrder: box => {

				return box.distanceToPoint(_ray.origin);

			},
			intersectsBounds: box => {

				if (firstHitOnly) {

					if (! _ray.intersectBox(box, _vec)) {

						return NOT_INTERSECTED;

					}

					// early out if the box is further than the closest raycast
					_vec.applyMatrix4(matrixWorld);
					return raycaster.ray.origin.distanceTo(_vec) < closestDistance ? INTERSECTED : NOT_INTERSECTED;

				} else {

					return _ray.intersectsBox(box) ? INTERSECTED : NOT_INTERSECTED;

				}

			},
			intersectsObject: (object, instanceId) => {

				// skip non visible objects
				if (! object.visible) {

					return;

				}

				localIntersects.length = 0;

				if ((object as InstancedMesh).isInstancedMesh && includeInstances) {

					const instancedMesh = object as InstancedMesh;

					// raycast the instance
					_mesh.geometry = instancedMesh.geometry;
					_mesh.material = instancedMesh.material;

					instancedMesh.getMatrixAt(instanceId, _mesh.matrixWorld);
					_mesh.matrixWorld.premultiply(instancedMesh.matrixWorld);
					_mesh.raycast(raycaster, localIntersects);

					localIntersects.forEach(hit => {

						hit.object = instancedMesh;
						hit.instanceId = instanceId;

					});

					_mesh.material = null as never;

				} else if ((object as BatchedMesh).isBatchedMesh && includeInstances) {

					const batchedMesh = object as BatchedMesh;

					if (! batchedMesh.getVisibleAt(instanceId)) {

						return;

					}

					// extract the geometry & material
					const geometryId = batchedMesh.getGeometryIdAt(instanceId);
					const geometryRange = batchedMesh.getGeometryRangeAt(geometryId, _geometryRange as { start: number; count: number; vertexStart: number; vertexCount: number; reservedVertexCount: number; indexStart: number; indexCount: number; reservedIndexCount: number })!;

					_geometry.index = batchedMesh.geometry.index;
					_geometry.attributes = batchedMesh.geometry.attributes;
					_geometry.setDrawRange(geometryRange.start, geometryRange.count);

					_mesh.geometry = _geometry;
					_mesh.material = batchedMesh.material;

					// perform a raycast against the proxy mesh
					batchedMesh.getMatrixAt(instanceId, _mesh.matrixWorld);
					_mesh.matrixWorld.premultiply(batchedMesh.matrixWorld);
					_mesh.raycast(raycaster, localIntersects);

					// fix up the fields
					localIntersects.forEach(hit => {

						hit.object = batchedMesh;
						(hit as Intersection & { batchId?: number }).batchId = instanceId;

					});

					_mesh.material = null as never;
					_geometry.index = null;
					_geometry.attributes = null as never;
					_geometry.setDrawRange(0, Infinity);

				} else {

					object.raycast(raycaster, localIntersects);

				}

				// find the closest hit to track
				if (firstHitOnly) {

					localIntersects.forEach(hit => {

						if (hit.distance < closestDistance) {

							closestDistance = hit.distance;
							closestHit = hit;

						}

					});

				} else {

					intersects.push(...localIntersects);

				}

			},
		});

		// save the closest hit only if firstHitOnly = true
		if (firstHitOnly && closestHit) {

			intersects.push(closestHit);

		}

		return intersects;

	}

	// get the bounding box of a primitive node accounting for the bvh options
	_getPrimitiveBoundingBox(compositeId: number, inverseMatrixWorld: Matrix4, target: Box3): void {

		const { objects, idMask, idBits, precise, includeInstances } = this;
		const id = getObjectId(compositeId, idMask);
		const instanceId = getInstanceId(compositeId, idBits, idMask);
		const object = objects[ id ];

		if (! includeInstances && ((object as InstancedMesh).isInstancedMesh || (object as BatchedMesh).isBatchedMesh)) {

			// if we're not using instances then just account for the overall bounds of the BatchedMesh and InstancedMesh
			if ((object as BatchedMesh).isBatchedMesh) {

				const batchedMesh = object as BatchedMesh;

				if (! batchedMesh.boundingBox) {

					batchedMesh.computeBoundingBox();

				}

				if (! batchedMesh.boundingSphere) {

					batchedMesh.computeBoundingSphere();

				}

				_matrix
					.copy(batchedMesh.matrixWorld)
					.premultiply(inverseMatrixWorld);

				_sphere
					.copy(batchedMesh.boundingSphere!)
					.applyMatrix4(_matrix);

				target
					.copy(batchedMesh.boundingBox!)
					.applyMatrix4(_matrix);

				shrinkToSphere(target, _sphere);

			} else {

				const instancedMesh = object as InstancedMesh;

				if (! instancedMesh.boundingBox) {

					instancedMesh.computeBoundingBox();

				}

				if (! instancedMesh.boundingSphere) {

					instancedMesh.computeBoundingSphere();

				}

				_matrix
					.copy(instancedMesh.matrixWorld)
					.premultiply(inverseMatrixWorld);

				_sphere
					.copy(instancedMesh.boundingSphere!)
					.applyMatrix4(_matrix);

				target
					.copy(instancedMesh.boundingBox!)
					.applyMatrix4(_matrix);

				shrinkToSphere(target, _sphere);

			}

		} else if (precise) {

			// calculate precise bounds if necessary by calculating the bounds of all vertices
			// in the bvh frame
			if ((object as InstancedMesh).isInstancedMesh) {

				const instancedMesh = object as InstancedMesh;

				instancedMesh
					.getMatrixAt(instanceId, _matrix);

				_matrix
					.premultiply(instancedMesh.matrixWorld)
					.premultiply(inverseMatrixWorld);

				getPreciseBounds(instancedMesh.geometry, _matrix, target);

			} else if ((object as BatchedMesh).isBatchedMesh) {

				const batchedMesh = object as BatchedMesh;
				const geometryId = batchedMesh.getGeometryIdAt(instanceId);
				const geometryRange = batchedMesh.getGeometryRangeAt(geometryId, _geometryRange as { start: number; count: number; vertexStart: number; vertexCount: number; reservedVertexCount: number; indexStart: number; indexCount: number; reservedIndexCount: number })!;

				_geometry.index = batchedMesh.geometry.index;
				_geometry.attributes = batchedMesh.geometry.attributes;
				_geometry.setDrawRange(geometryRange.start, geometryRange.count);

				batchedMesh
					.getMatrixAt(instanceId, _matrix);

				_matrix
					.premultiply(batchedMesh.matrixWorld)
					.premultiply(inverseMatrixWorld);

				getPreciseBounds(_geometry, _matrix, target);

				_geometry.attributes = null as never;

			} else {

				_matrix
					.copy(object.matrixWorld)
					.premultiply(inverseMatrixWorld);

				target.setFromObject(object, true).applyMatrix4(inverseMatrixWorld);

			}

		} else {

			// otherwise use the fast path of extracting the cached, AABB bounds and transforming them
			// into the local BVH frame
			if ((object as InstancedMesh).isInstancedMesh) {

				const instancedMesh = object as InstancedMesh;

				if (! instancedMesh.geometry.boundingBox) {

					instancedMesh.geometry.computeBoundingBox();

				}

				if (! instancedMesh.geometry.boundingSphere) {

					instancedMesh.geometry.computeBoundingSphere();

				}

				instancedMesh
					.getMatrixAt(instanceId, _matrix);

				_matrix
					.premultiply(instancedMesh.matrixWorld)
					.premultiply(inverseMatrixWorld);

				_sphere
					.copy(instancedMesh.geometry.boundingSphere!)
					.applyMatrix4(_matrix);

				target
					.copy(instancedMesh.geometry.boundingBox!)
					.applyMatrix4(_matrix);

				shrinkToSphere(target, _sphere);

			} else if ((object as BatchedMesh).isBatchedMesh) {

				const batchedMesh = object as BatchedMesh;
				const geometryId = batchedMesh.getGeometryIdAt(instanceId);

				batchedMesh
					.getMatrixAt(instanceId, _matrix);

				_matrix
					.premultiply(batchedMesh.matrixWorld)
					.premultiply(inverseMatrixWorld);

				batchedMesh
					.getBoundingSphereAt(geometryId, _sphere)
					?.applyMatrix4(_matrix);

				batchedMesh
					.getBoundingBoxAt(geometryId, target)
					?.applyMatrix4(_matrix);

				shrinkToSphere(target, _sphere);

			} else {

				target
					.setFromObject(object, false)
					.applyMatrix4(inverseMatrixWorld);

			}

		}

	}

	// counts the total number of primitives required by the objects in given array of objects
	_countPrimitives(objects: Object3D[]): number {

		const { includeInstances } = this;
		let total = 0;
		objects.forEach(object => {

			if ((object as InstancedMesh).isInstancedMesh && includeInstances) {

				total += (object as InstancedMesh).count;

			} else if ((object as BatchedMesh).isBatchedMesh && includeInstances) {

				if (! ('instanceCount' in object)) {

					throw new Error('ObjectBVH: Three.js revision >= r169 is required to use BatchedMesh.');

				}

				total += (object as BatchedMesh).instanceCount;

			} else {

				total ++;

			}

		});

		return total;

	}

	_fillPrimitiveBuffer(objects: Object3D[], idBits: number, target: Uint32Array): void {

		const { includeInstances } = this;
		let index = 0;
		objects.forEach((object, i) => {

			if ((object as InstancedMesh).isInstancedMesh && includeInstances) {

				const instancedMesh = object as InstancedMesh;
				const count = instancedMesh.count;
				for (let c = 0; c < count; c ++) {

					target[ index ] = (c << idBits) | i;
					index ++;

				}

			} else if ((object as BatchedMesh).isBatchedMesh && includeInstances) {

				const batchedMesh = object as BatchedMesh;
				const instanceCount = batchedMesh.instanceCount;
				const maxInstanceCount = batchedMesh.maxInstanceCount;
				let foundInstances = 0;
				let iter = 0;

				while (foundInstances < instanceCount && iter < maxInstanceCount) {

					// TODO: it would be better to have a consistent way of querying whether an
					// instance were active
					try {

						batchedMesh.getVisibleAt(iter);

						target[ index ] = (iter << idBits) | i;
						foundInstances ++;
						index ++;

					} catch {

						//

					}

					iter ++;

				}

			} else {

				target[ index ] = i;
				index ++;

			}

		});

	}

}

// id functions
// construct a mask with the given number of bits set to 1
function constructIdMask(idBits: number): number {

	let mask = 0;
	for (let i = 0; i < idBits; i ++) {

		mask = mask << 1 | 1;

	}

	return mask;

}

// extract the primary object id given the provided mask
function getObjectId(id: number, idMask: number): number {

	return id & idMask;

}

// extract the instance id given the mask and number of bits to shift
function getInstanceId(id: number, idBits: number, idMask: number): number {

	return (id & (~ idMask)) >> idBits;

}

// traverse the full scene and collect all leaves
function collectObjects(root: Object3D | Object3D[], objectSet: Set<Object3D> = new Set()): void {

	if (Array.isArray(root)) {

		root.forEach(object => collectObjects(object, objectSet));

	} else {

		root.traverse(child => {

			if ((child as Mesh).isMesh || (child as { isLine?: boolean }).isLine || (child as { isPoints?: boolean }).isPoints) {

				objectSet.add(child);

			}

		});

	}

}

// calculate precise box bounds of the given geometry in the given frame
function getPreciseBounds(geometry: BufferGeometry, matrix: Matrix4, target: Box3): Box3 {

	target.makeEmpty();

	const drawRange = geometry.drawRange;
	const indexAttr = geometry.index;
	const posAttr = geometry.attributes.position as BufferAttribute;
	const start = drawRange.start;
	const vertCount = indexAttr ? indexAttr.count : posAttr.count;
	const count = Math.min(vertCount - start, drawRange.count);
	for (let i = start, l = start + count; i < l; i ++) {

		let vi = i;
		if (indexAttr) {

			vi = indexAttr.getX(vi);

		}

		_vec.fromBufferAttribute(posAttr, vi).applyMatrix4(matrix);
		target.expandByPoint(_vec);

	}

	return target;

}

// iterator helper for raycasting
function iterateOverObjects(
	offset: number,
	count: number,
	bvh: ObjectBVH,
	callback: IntersectsObjectCallback,
	contained: boolean,
	depth: number,
	// scratch primitive (unused for objects)
	_scratch: unknown,
): boolean {

	const { primitiveBuffer, objects, idMask, idBits } = bvh;
	for (let i = offset, l = count + offset; i < l; i ++) {

		const compositeId = primitiveBuffer![ i ];
		const id = getObjectId(compositeId, idMask);
		const instanceId = getInstanceId(compositeId, idBits, idMask);
		const object = objects[ id ];
		if (callback(object, instanceId, contained, depth)) {

			return true;

		}

	}

	return false;

}

function shrinkToSphere(box: Box3, sphere: Sphere): void {

	_vec.copy(sphere.center).addScalar(- sphere.radius);
	box.min.max(_vec);

	_vec.copy(sphere.center).addScalar(sphere.radius);
	box.max.min(_vec);

}

import { Vector3, Matrix4, Ray, Box3, BufferAttribute, Object3D, Raycaster, Intersection } from 'three';
import { INTERSECTED, NOT_INTERSECTED } from './Constants';
import { PrimitivePool } from '../utils/PrimitivePool.js';
import { GeometryBVH } from './GeometryBVH';

const _inverseMatrix = /* @__PURE__ */ new Matrix4();
const _ray = /* @__PURE__ */ new Ray();
const _pointPool = /* @__PURE__ */ new PrimitivePool( () => new Vector3() );
const _box = /* @__PURE__ */ new Box3();

/** Callback invoked for each point primitive during `shapecast`. */
export type IntersectsPointCallback = (
	point: Vector3,
	index: number,
	contained: boolean,
	depth: number,
) => boolean | void;

/** Callbacks accepted by {@link PointsBVH.shapecast}. */
export interface PointsBVHShapecastCallbacks {

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

	intersectsPoint?: IntersectsPointCallback;

}

// Internal: a Float32Array carrying an `offset` field used by the build/cast helpers.
type OffsetFloat32Array = Float32Array & { offset?: number };

/**
 * BVH for `THREE.Points` geometries. Each BVH primitive represents a single point.
 */
export class PointsBVH extends GeometryBVH {

	override get primitiveStride(): number {

		return 1;

	}

	writePrimitiveBounds( i: number, targetBuffer: OffsetFloat32Array, baseIndex: number ): OffsetFloat32Array {

		const indirectBuffer = this._indirectBuffer;
		const { geometry } = this;
		const posAttr = geometry.attributes.position as BufferAttribute;
		const indexAttr = geometry.index;
		let pointIndex = indirectBuffer ? indirectBuffer[ i ] : i;
		if ( indexAttr ) {

			pointIndex = indexAttr.getX( pointIndex );

		}

		const px = posAttr.getX( pointIndex );
		const py = posAttr.getY( pointIndex );
		const pz = posAttr.getZ( pointIndex );

		// Write in min/max format [minx, miny, minz, maxx, maxy, maxz]
		// For points, min equals max (epsilon padding is applied in computePrimitiveBounds)
		targetBuffer[ baseIndex + 0 ] = px;
		targetBuffer[ baseIndex + 1 ] = py;
		targetBuffer[ baseIndex + 2 ] = pz;
		targetBuffer[ baseIndex + 3 ] = px;
		targetBuffer[ baseIndex + 4 ] = py;
		targetBuffer[ baseIndex + 5 ] = pz;

		return targetBuffer;

	}

	/**
	 * Performs a spatial query against the BVH. Extends the base `shapecast` with an
	 * `intersectsPoint` callback that is called once per point primitive in leaf nodes.
	 *
	 * @param {PointsBVHShapecastCallbacks} callbacks - The shapecast callbacks.
	 * @returns {boolean} Whether an intersection was found.
	 */
	shapecast( callbacks: PointsBVHShapecastCallbacks ): boolean {

		// TODO: avoid unnecessary "iterate over points" function
		const point = _pointPool.getPrimitive() as Vector3;
		const result = super.shapecast(
			{
				...callbacks,
				intersectsPrimitive: callbacks.intersectsPoint,
				scratchPrimitive: point,
				iterate: iterateOverPoints,
			},
		);

		_pointPool.releasePrimitive( point );
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

		const { geometry } = this;
		const { matrixWorld } = object;
		const firstHitOnly = ( raycaster as Raycaster & { firstHitOnly?: boolean } ).firstHitOnly;

		_inverseMatrix.copy( matrixWorld ).invert();
		_ray.copy( raycaster.ray ).applyMatrix4( _inverseMatrix );

		const threshold = raycaster.params.Points.threshold;
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
			intersectsPoint: ( point, index ) => {

				const rayPointDistanceSq = _ray.distanceSqToPoint( point );
				if ( rayPointDistanceSq < localThresholdSq ) {

					const intersectPoint = new Vector3();

					_ray.closestPointToPoint( point, intersectPoint );
					intersectPoint.applyMatrix4( matrixWorld );

					const distance = raycaster.ray.origin.distanceTo( intersectPoint );

					if ( distance < raycaster.near || distance > raycaster.far ) return;

					if ( firstHitOnly && distance >= closestDistance ) return;
					closestDistance = distance;

					const resolvedIndex = this.resolvePrimitiveIndex( index );

					closestHit = {
						distance,
						// TODO: this doesn't seem right?
						distanceToRay: Math.sqrt( rayPointDistanceSq ),
						point: intersectPoint,
						index: geometry.index ? geometry.index.getX( resolvedIndex ) : resolvedIndex,
						face: null,
						faceIndex: null,
						barycoord: null,
						object,
					};

					if ( ! firstHitOnly ) {

						intersects.push( closestHit );

					}

				}

			},
		} );

		if ( firstHitOnly && closestHit ) {

			intersects.push( closestHit );

		}

		return intersects;

	}

}

function iterateOverPoints(
	offset: number,
	count: number,
	bvh: PointsBVH,
	intersectsPointFunc: ( point: Vector3, index: number, contained: boolean, depth: number ) => boolean | void,
	contained: boolean,
	depth: number,
	point: Vector3,
): boolean {

	const { geometry } = bvh;
	const { index } = geometry;
	const pos = geometry.attributes.position as BufferAttribute;

	for ( let i = offset, l = count + offset; i < l; i ++ ) {

		const prim = bvh.resolvePrimitiveIndex( i );
		const vertexIndex = index ? ( index.array as Uint32Array | Uint16Array )[ prim ] : prim;
		point.fromBufferAttribute( pos, vertexIndex );

		if ( intersectsPointFunc( point, i, contained, depth ) ) {

			return true;

		}

	}

	return false;

}

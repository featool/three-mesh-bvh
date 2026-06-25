class _BufferStack {

	float32Array: Float32Array | null;
	uint16Array: Uint16Array | null;
	uint32Array: Uint32Array | null;

	constructor() {

		this.float32Array = null;
		this.uint16Array = null;
		this.uint32Array = null;

		const stack: ArrayBuffer[] = [];
		let prevBuffer: ArrayBuffer | null = null;
		this.setBuffer = ( buffer: ArrayBuffer ) => {

			if ( prevBuffer ) {

				stack.push( prevBuffer );

			}

			prevBuffer = buffer;
			this.float32Array = new Float32Array( buffer );
			this.uint16Array = new Uint16Array( buffer );
			this.uint32Array = new Uint32Array( buffer );

		};

		this.clearBuffer = () => {

			prevBuffer = null;
			this.float32Array = null;
			this.uint16Array = null;
			this.uint32Array = null;

			if ( stack.length !== 0 ) {

				this.setBuffer( stack.pop()! );

			}

		};

	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	setBuffer( _buffer: ArrayBuffer ): void {}
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	clearBuffer(): void {}

}

export const BufferStack = /* @__PURE__ */ new _BufferStack();

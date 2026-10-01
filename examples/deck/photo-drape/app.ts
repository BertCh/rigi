// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {COORDINATE_SYSTEM, Deck, LinearInterpolator} from '@deck.gl/core';
import {LineLayer} from '@deck.gl/layers';
import type {Device, Texture} from '@luma.gl/core';
import {DynamicTexture} from '@luma.gl/engine';
import {getDeckExampleProps, type DeckExampleDeviceOptions} from '../deck-example-device';
import {
  DEM_TILE_SIZE,
  getDemTileKey,
  loadDemTile,
  makeLocalFrame,
  selectDemTiles,
  type DemTile
} from './dem-tiles';
import {PhotoDrapeEffect} from './photo-drape-effect';
import {PhotoDrapeTerrainLayer} from './photo-drape-terrain-layer';
import {
  PhotoOrbitView,
  getCameraAxes,
  getPhotoOrbitViewState,
  type PhotoOrbitViewState
} from './photo-orbit-view';
import {LAKE_THUN_ELEVATION, NIEDERHORN_CAMERA} from './scene-data';

type Vector3 = [number, number, number];
type FrustumEdge = {source: Vector3; target: Vector3};

const PHOTO_URL = new URL('./niederhorn.jpg', import.meta.url).href;
const CONCURRENT_TILE_REQUESTS = 6;
/** 1024 × 768: the photo's 4:3, about 0.07° per texel. */
const SHADOW_MAP_WIDTH = 1024;
const SHADOW_MAP_HEIGHT = 768;
/** Length of the drawn photo frustum, metres. */
const FRUSTUM_LENGTH = 6000;
const FRUSTUM_COLOR: [number, number, number, number] = [255, 214, 90, 255];
/** At the end of the flight the orbit target sits this far in front of the lens. */
const FLIGHT_TARGET_DISTANCE = 1000;
const FLIGHT_DURATION = 2500;
const ORBIT_TRANSITION_PROPS = ['target', 'zoom', 'rotationX', 'rotationOrbit'];

export type PhotoDrapeDiagnostics = {
  frames: number;
  backend: string;
  error: string;
  finalized: boolean;
  tilesRequested: number;
  tilesLoaded: number;
  tilesFailed: number;
  photoLoaded: boolean;
  /** Shadow-map renders so far: one per photo pose and terrain, never per frame. */
  shadowMapPasses: number;
};

export function createPhotoDrapeScene(
  parent: HTMLDivElement,
  options: DeckExampleDeviceOptions = {}
) {
  const camera = NIEDERHORN_CAMERA;
  const frame = makeLocalFrame(camera.longitude, camera.latitude);
  const tiles = selectDemTiles(frame, camera);
  const loadedTiles: DemTile[] = [];
  const abortController = new AbortController();
  const photoPosition: Vector3 = [0, 0, camera.altitude];
  const frustumEdges = getFrustumEdges(photoPosition);
  const initialViewState = getOverviewViewState();
  let orbitViewState: PhotoOrbitViewState = initialViewState;
  let demTexture: Texture | null = null;
  let photoTexture: DynamicTexture | null = null;
  let frustumVisible = true;
  let height = Math.max(parent.clientHeight, 1);
  let pendingFrames: (() => void)[] = [];
  let pendingFlight: (() => void) | null = null;
  const diagnostics: PhotoDrapeDiagnostics = {
    frames: 0,
    backend: '',
    error: '',
    finalized: false,
    tilesRequested: tiles.length,
    tilesLoaded: 0,
    tilesFailed: 0,
    photoLoaded: false,
    shadowMapPasses: 0
  };

  const photoDrapeEffect = new PhotoDrapeEffect({
    position: photoPosition,
    pose: camera,
    terrainRevision: null,
    photo: null,
    opacity: 1,
    showShadowedAreas: false,
    shadowMapWidth: SHADOW_MAP_WIDTH,
    shadowMapHeight: SHADOW_MAP_HEIGHT
  });

  let resolveDevice: (device: Device) => void = () => {};
  const deviceReady = new Promise<Device>(resolve => {
    resolveDevice = resolve;
  });
  let rejectReady: (error: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => {
    rejectReady = reject;
  });

  const deviceProps = getDeckExampleProps(options);
  const deck = new Deck<PhotoOrbitView>({
    parent,
    ...deviceProps,
    deviceProps: {
      ...deviceProps.deviceProps,
      createCanvasContext: {alphaMode: 'premultiplied'},
      webgl: {alpha: true}
    },
    views: new PhotoOrbitView({
      id: 'orbit',
      // The photo's field of view, so that flying into the photo reproduces its framing.
      fovy: camera.verticalFieldOfView,
      controller: true,
      rollAnchor: {position: photoPosition, roll: camera.roll, fadeDistance: 2000}
    }),
    viewState: orbitViewState,
    onViewStateChange: ({viewState}) => {
      orbitViewState = viewState as PhotoOrbitViewState;
      deck.setProps({viewState: orbitViewState});
    },
    effects: [photoDrapeEffect],
    layers: [],
    onDeviceInitialized: device => {
      diagnostics.backend = device.type;
      // One array layer per selected tile; layers fill in as tiles arrive.
      demTexture = device.createTexture({
        id: 'photo-drape-dem-tiles',
        dimension: '2d-array',
        format: 'rgba8unorm',
        width: DEM_TILE_SIZE,
        height: DEM_TILE_SIZE,
        depth: tiles.length
      });
      resolveDevice(device);
    },
    onResize: size => {
      height = size.height;
    },
    onAfterRender: () => {
      diagnostics.frames++;
      diagnostics.shadowMapPasses = photoDrapeEffect.shadowMapPasses;
      const callbacks = pendingFrames;
      pendingFrames = [];
      for (const callback of callbacks) callback();
    },
    onError: error => {
      diagnostics.error ||= error.message;
      rejectReady(error);
    }
  });

  function waitForFrame(): Promise<void> {
    return new Promise(resolve => {
      pendingFrames.push(resolve);
      deck.redraw('photo drape changed');
    });
  }

  function updateLayers(): void {
    if (!demTexture) return;
    deck.setProps({
      layers: [
        new PhotoDrapeTerrainLayer({
          id: 'terrain',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          tiles: [...loadedTiles],
          demTexture,
          frame
        }),
        new LineLayer<FrustumEdge>({
          id: 'photo-frustum',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          data: frustumEdges,
          visible: frustumVisible,
          getSourcePosition: edge => edge.source,
          getTargetPosition: edge => edge.target,
          getColor: FRUSTUM_COLOR,
          getWidth: 2,
          widthUnits: 'pixels'
        })
      ]
    });
  }

  /** Changes effect props, then draws a frame so the change shows. */
  function setEffectProps(props: Parameters<PhotoDrapeEffect['setProps']>[0]): void {
    photoDrapeEffect.setProps(props);
    deck.redraw('photo drape effect changed');
  }

  /** The photo is optional: without it (a fresh clone, see README) the render still runs. */
  async function loadPhoto(device: Device): Promise<void> {
    const response = await fetch(PHOTO_URL, {signal: abortController.signal});
    const blob = await response.blob();
    if (!response.ok || !blob.type.startsWith('image/')) return;
    const image = await createImageBitmap(blob);
    if (diagnostics.finalized) {
      image.close();
      return;
    }
    // Mipmapped: from the orbit view the photo is minified many times over.
    photoTexture = new DynamicTexture(device, {
      id: 'photo-drape-photo',
      data: image,
      format: 'rgba8unorm',
      mipmaps: true,
      mipLevels: 'auto',
      sampler: {
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
      }
    });
    await photoTexture.ready;
    image.close();
    diagnostics.photoLoaded = true;
    setEffectProps({photo: photoTexture.texture});
  }

  /** Streams the selected tiles, nearest first, into their texture array layers. */
  async function loadTiles(): Promise<void> {
    const queue = [...tiles];
    const loadNextTile = async (): Promise<void> => {
      for (let tile = queue.shift(); tile; tile = queue.shift()) {
        await loadTile(tile);
      }
    };
    await Promise.all(Array.from({length: CONCURRENT_TILE_REQUESTS}, loadNextTile));
    // The terrain is complete: the shadow map can be drawn, once.
    setEffectProps({terrainRevision: diagnostics.tilesLoaded});
  }

  async function loadTile(tile: DemTile): Promise<void> {
    try {
      const pixels = await loadDemTile(tile, abortController.signal);
      if (diagnostics.finalized || !demTexture) return;
      demTexture.writeData(pixels, {z: tile.layer, depthOrArrayLayers: 1});
      loadedTiles.push(tile);
      diagnostics.tilesLoaded++;
      updateLayers();
    } catch (error) {
      if (abortController.signal.aborted) return;
      // Coverage gaps are expected at the edge of the view; draw what loaded.
      diagnostics.tilesFailed++;
      console.warn(`Photo drape: DEM tile ${getDemTileKey(tile)}`, error);
    }
  }

  /** Animates the orbit camera with a deck.gl view-state transition. */
  function flyTo(viewState: PhotoOrbitViewState, duration: number): Promise<void> {
    pendingFlight?.();
    // Turn the shorter way round.
    const headingChange =
      ((viewState.rotationOrbit - orbitViewState.rotationOrbit + 540) % 360) - 180;
    return new Promise(resolve => {
      pendingFlight = resolve;
      orbitViewState = {
        ...viewState,
        rotationOrbit: orbitViewState.rotationOrbit + headingChange,
        transitionDuration: duration,
        transitionInterpolator: new LinearInterpolator({transitionProps: ORBIT_TRANSITION_PROPS}),
        onTransitionEnd: () => {
          pendingFlight = null;
          // Resolve after the final state has been drawn, outside deck.gl's frame callback.
          setTimeout(() => waitForFrame().then(resolve));
        },
        onTransitionInterrupt: () => {
          pendingFlight = null;
          resolve();
        }
      };
      deck.setProps({viewState: orbitViewState});
    });
  }

  updateLayers();

  const ready = Promise.race([
    failed,
    (async () => {
      const device = await deviceReady;
      updateLayers();
      await Promise.all([loadPhoto(device), loadTiles()]);
      await waitForFrame();
      // The shadow map pipeline may need a frame or two to compile.
      for (let attempt = 0; attempt < 30 && !photoDrapeEffect.isShadowMapCurrent; attempt++) {
        await waitForFrame();
      }
    })()
  ]);

  return {
    deck,
    ready,
    diagnostics,
    /** 0 leaves the hillshade, 1 shows the photo wherever the camera saw the terrain. */
    setDrapeOpacity(value: number) {
      setEffectProps({opacity: value});
    },
    /** Tints terrain inside the photo frame that the camera did not see. */
    setShadowedAreasVisible(value: boolean) {
      setEffectProps({showShadowedAreas: value});
    },
    setFrustumVisible(value: boolean) {
      frustumVisible = value;
      updateLayers();
    },
    /** Animates the orbit camera into the photo camera; resolves once the photo framing is drawn. */
    flyIntoPhoto(duration = FLIGHT_DURATION): Promise<void> {
      return flyTo(
        getPhotoOrbitViewState(photoPosition, camera, FLIGHT_TARGET_DISTANCE, height),
        duration
      );
    },
    /** Animates back to the overview. */
    resetOrbit(duration = FLIGHT_DURATION): Promise<void> {
      return flyTo(initialViewState, duration);
    },
    /** Jumps to an orbit view state (tests). */
    setOrbitViewState(viewState: Partial<PhotoOrbitViewState>) {
      orbitViewState = {...orbitViewState, ...viewState};
      deck.setProps({viewState: orbitViewState});
    },
    getOrbitViewState: () => orbitViewState,
    waitForFrame,
    finalize() {
      if (diagnostics.finalized) return;
      diagnostics.finalized = true;
      abortController.abort();
      pendingFlight?.();
      deck.finalize();
      demTexture?.destroy();
      photoTexture?.destroy();
    }
  };

  /** Looks west over Lake Thun from above the north shore, towards the draped slopes. */
  function getOverviewViewState(): PhotoOrbitViewState {
    const {forward} = getCameraAxes(camera);
    const horizontalLength = Math.hypot(forward[0], forward[1]);
    const targetDistance = 9000;
    return {
      target: [
        (forward[0] / horizontalLength) * targetDistance,
        (forward[1] / horizontalLength) * targetDistance,
        LAKE_THUN_ELEVATION
      ],
      zoom: -5.2,
      rotationX: 38,
      rotationOrbit: camera.yaw - 35
    };
  }

  /** The photo frustum: four edges from the lens and the rectangle where they end. */
  function getFrustumEdges(position: Vector3): FrustumEdge[] {
    const {forward, right, up} = getCameraAxes(camera);
    const halfHeight = Math.tan(((camera.verticalFieldOfView / 2) * Math.PI) / 180);
    const halfWidth = halfHeight * camera.aspectRatio;
    const corners = [
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1]
    ].map(
      ([horizontal, vertical]) =>
        position.map(
          (value, index) =>
            value +
            FRUSTUM_LENGTH *
              (forward[index] +
                horizontal * halfWidth * right[index] +
                vertical * halfHeight * up[index])
        ) as Vector3
    );
    return corners.flatMap((corner, index) => [
      {source: position, target: corner},
      {source: corner, target: corners[(index + 1) % corners.length]}
    ]);
  }
}

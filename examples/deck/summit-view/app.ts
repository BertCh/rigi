// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {COORDINATE_SYSTEM, Deck, OrthographicView} from '@deck.gl/core';
import {BitmapLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import type {Device, Texture} from '@luma.gl/core';
import {getDeckExampleProps, type DeckExampleDeviceOptions} from '../deck-example-device';
import {
  DEM_TILE_SIZE,
  REFRACTION_COEFFICIENT,
  getDemTileKey,
  getLocalPosition,
  isPointVisible,
  loadDemTile,
  makeLocalFrame,
  selectDemTiles,
  type DemTile,
  type LoadedDemTile
} from './dem-tiles';
import {NIEDERHORN_CAMERA, PEAKS, type Peak} from './scene-data';
import {SummitView, SummitViewport, getCameraAxes, type SummitViewState} from './summit-view';
import {TerrariumTerrainLayer} from './terrarium-terrain-layer';

/** A summit label in canvas pixels (y down). */
export type PeakLabel = Peak & {x: number; y: number; visible: boolean};

const PHOTO_URL = new URL('./niederhorn.jpg', import.meta.url).href;
const CONCURRENT_TILE_REQUESTS = 6;
const NEAR_PLANE = 80;
const TEXT_COLOR: [number, number, number, number] = [255, 255, 255, 255];
const LABEL_BACKGROUND: [number, number, number, number] = [8, 12, 20, 190];

export function createSummitViewScene(
  parent: HTMLDivElement,
  options: DeckExampleDeviceOptions = {}
) {
  const camera = NIEDERHORN_CAMERA;
  const frame = makeLocalFrame(camera.longitude, camera.latitude);
  const tiles = selectDemTiles(frame, camera);
  const loadedTiles = new Map<string, LoadedDemTile>();
  const abortController = new AbortController();
  const photoViewState: SummitViewState = {
    ...camera,
    position: [0, 0, camera.altitude],
    // GPS puts the lens within about 30 m, and the 0.5 m swissALTI3D surface has it 15 m below
    // ground on the Niederhorn summit. Terrain nearer than this is not trustworthy: clip it.
    near: NEAR_PLANE
  };
  let demTexture: Texture | null = null;
  let photo: ImageBitmap | null = null;
  let photoBlend = 0;
  let labelsVisible = true;
  let earthCurvature = true;
  let width = Math.max(parent.clientWidth, 1);
  let height = Math.max(parent.clientHeight, 1);
  let labels: PeakLabel[] = [];
  let pendingFrames: (() => void)[] = [];
  const diagnostics = {
    frames: 0,
    backend: '',
    error: '',
    finalized: false,
    tilesRequested: tiles.length,
    tilesLoaded: 0,
    tilesFailed: 0,
    labels
  };

  let resolveDevice: (device: Device) => void = () => {};
  const deviceReady = new Promise<Device>(resolve => {
    resolveDevice = resolve;
  });
  let rejectReady: (error: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => {
    rejectReady = reject;
  });

  const deviceProps = getDeckExampleProps(options);
  const deck = new Deck<[SummitView, OrthographicView]>({
    parent,
    ...deviceProps,
    deviceProps: {
      ...deviceProps.deviceProps,
      createCanvasContext: {alphaMode: 'premultiplied'},
      webgl: {alpha: true}
    },
    // The photo camera draws the terrain; a pixel-space view draws the photo and labels on top.
    views: [new SummitView({id: 'photo'}), new OrthographicView({id: 'screen'})],
    viewState: getViewState(),
    layerFilter: ({layer, viewport}) => layer.id.startsWith('screen-') === (viewport.id === 'screen'),
    layers: [],
    onDeviceInitialized: device => {
      diagnostics.backend = device.type;
      // One array layer per selected tile; layers fill in as tiles arrive.
      demTexture = device.createTexture({
        id: 'summit-view-dem-tiles',
        dimension: '2d-array',
        format: 'rgba8unorm',
        width: DEM_TILE_SIZE,
        height: DEM_TILE_SIZE,
        depth: tiles.length
      });
      resolveDevice(device);
    },
    onResize: size => {
      width = size.width;
      height = size.height;
      updateLabels();
    },
    onAfterRender: () => {
      diagnostics.frames++;
      const callbacks = pendingFrames;
      pendingFrames = [];
      for (const callback of callbacks) callback();
    },
    onError: error => {
      diagnostics.error ||= error.message;
      rejectReady(error);
    }
  });

  function getViewState() {
    return {
      photo: photoViewState,
      screen: {target: [width / 2, height / 2, 0] as [number, number, number], zoom: 0}
    };
  }

  function waitForFrame(): Promise<void> {
    return new Promise(resolve => {
      pendingFrames.push(resolve);
      deck.redraw('summit view changed');
    });
  }

  function getCurvatureScale(): number {
    return earthCurvature ? 1 - REFRACTION_COEFFICIENT : 0;
  }

  /** Projects each summit into the canvas and hides the ones terrain or the frame cut off. */
  function updateLabels(): void {
    const viewport = new SummitViewport({...photoViewState, width, height});
    const {forward} = getCameraAxes(camera);
    const curvatureScale = getCurvatureScale();
    labels = PEAKS.map(peak => {
      const position = getLocalPosition(
        frame,
        peak.longitude,
        peak.latitude,
        peak.elevation,
        curvatureScale
      );
      const offset = position.map((value, index) => value - photoViewState.position[index]);
      const inFront = offset[0] * forward[0] + offset[1] * forward[1] + offset[2] * forward[2] > 0;
      const [x, y] = viewport.project(position);
      const inFrame = inFront && x >= 0 && x <= width && y >= 0 && y <= height;
      const visible =
        inFrame &&
        isPointVisible(
          frame,
          loadedTiles,
          camera.altitude,
          peak.longitude,
          peak.latitude,
          peak.elevation,
          curvatureScale
        );
      return {...peak, x, y, visible};
    });
    diagnostics.labels = labels;
    updateLayers();
  }

  function updateLayers(): void {
    if (!demTexture) {
      deck.setProps({viewState: getViewState()});
      return;
    }
    const visibleLabels = labels.filter(label => label.visible);
    deck.setProps({
      viewState: getViewState(),
      layers: [
        new TerrariumTerrainLayer({
          id: 'terrain',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          tiles: Array.from(loadedTiles.values()),
          demTexture,
          frame,
          curvatureScale: getCurvatureScale(),
          cameraPosition: photoViewState.position
        }),
        new BitmapLayer({
          id: 'screen-photo',
          image: photo,
          bounds: [0, height, width, 0],
          opacity: photoBlend,
          visible: photo !== null && photoBlend > 0,
          parameters: {depthCompare: 'always', depthWriteEnabled: false}
        }),
        new ScatterplotLayer<PeakLabel>({
          id: 'screen-peak-markers',
          data: visibleLabels,
          visible: labelsVisible,
          getPosition: label => [label.x, label.y],
          getRadius: 3,
          radiusUnits: 'pixels',
          getFillColor: TEXT_COLOR,
          stroked: true,
          getLineColor: LABEL_BACKGROUND,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          parameters: {depthCompare: 'always', depthWriteEnabled: false}
        }),
        new TextLayer<PeakLabel>({
          id: 'screen-peak-labels',
          data: visibleLabels,
          visible: labelsVisible,
          characterSet: 'auto',
          fontFamily: 'system-ui, sans-serif',
          getPosition: label => [label.x, label.y],
          getText: label => `${label.name} ${Math.round(label.elevation)} m`,
          getSize: 13,
          getColor: TEXT_COLOR,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          getPixelOffset: [0, -8],
          background: true,
          getBackgroundColor: LABEL_BACKGROUND,
          backgroundPadding: [5, 2],
          parameters: {depthCompare: 'always', depthWriteEnabled: false}
        })
      ]
    });
  }

  async function loadPhoto(): Promise<void> {
    const response = await fetch(PHOTO_URL, {signal: abortController.signal});
    photo = await createImageBitmap(await response.blob());
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
  }

  async function loadTile(tile: DemTile): Promise<void> {
    try {
      const {pixels, elevations} = await loadDemTile(tile, abortController.signal);
      if (diagnostics.finalized || !demTexture) return;
      demTexture.writeData(pixels, {z: tile.layer, depthOrArrayLayers: 1});
      loadedTiles.set(getDemTileKey(tile.z, tile.x, tile.y), {...tile, elevations});
      diagnostics.tilesLoaded++;
      updateLayers();
    } catch (error) {
      if (abortController.signal.aborted) return;
      // Coverage gaps are expected at the edge of the view; draw what loaded.
      diagnostics.tilesFailed++;
      console.warn(`Summit view: DEM tile ${getDemTileKey(tile.z, tile.x, tile.y)}`, error);
    }
  }

  const ready = Promise.race([
    failed,
    (async () => {
      await deviceReady;
      await Promise.all([loadPhoto(), loadTiles()]);
      updateLabels();
      await waitForFrame();
    })()
  ]);

  return {
    deck,
    ready,
    diagnostics,
    /** 0 shows the render, 1 the photo. */
    setPhotoBlend(value: number) {
      photoBlend = value;
      updateLayers();
    },
    setLabelsVisible(value: boolean) {
      labelsVisible = value;
      updateLayers();
    },
    /** Toggles the earth-curvature drop and refraction lift; labels are re-projected to match. */
    setEarthCurvature(value: boolean) {
      earthCurvature = value;
      updateLabels();
    },
    waitForFrame,
    finalize() {
      if (diagnostics.finalized) return;
      diagnostics.finalized = true;
      abortController.abort();
      deck.finalize();
      demTexture?.destroy();
      photo?.close();
    }
  };
}

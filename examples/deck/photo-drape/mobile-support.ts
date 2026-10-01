// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors
import type {ExampleSupportDefinition} from '../../example-support';
const exampleSupport = {
  id: 'deck/photo-drape',
  mobileMode: 'full',
  mobileProfile: 'large-data',
  requirements: {backends: ['webgpu', 'webgl2']}
} satisfies ExampleSupportDefinition;
export default exampleSupport;

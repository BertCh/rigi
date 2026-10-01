// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors
import type {ExampleSupportDefinition} from '../../example-support';
const exampleSupport = {
  id: 'deck/summit-view',
  mobileMode: 'full',
  mobileProfile: 'large-data',
  requirements: {backends: ['webgpu', 'webgl2']}
} satisfies ExampleSupportDefinition;
export default exampleSupport;

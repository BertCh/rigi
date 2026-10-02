// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type {ExampleSupportDefinition} from '../../example-support';

const exampleSupport = {
  id: 'gpgpu/photo-graph',
  mobileMode: 'full',
  mobileProfile: 'standard',
  requirements: {backends: ['webgpu']}
} satisfies ExampleSupportDefinition;

export default exampleSupport;

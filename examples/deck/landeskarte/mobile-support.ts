// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors
import type {ExampleSupportDefinition} from '../../example-support';
const exampleSupport = {
  id: 'deck/landeskarte',
  mobileMode: 'reduced',
  mobileProfile: 'large-data',
  requirements: {backends: ['webgpu', 'webgl2']}
} satisfies ExampleSupportDefinition;
export default exampleSupport;

#!/usr/bin/env node

// hb-p1-tools/cli/p1.js
//
// Homebridge P1 Tools.
// Copyright © 2020-2026 Erik Baauw. All rights reserved.

import { P1Tool } from 'hb-p1-tools/P1Tool'

await new P1Tool().main()

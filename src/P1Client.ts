// hb-p1-tools/lib/P1Client.js
//
// Homebridge P1 Tools.
// Copyright © 2018-2026 Erik Baauw. All rights reserved.

import type { Socket } from 'node:net'
import type { Logger, integer, json, jsonMap } from 'hb-lib-tools'
import type { host, path } from 'hb-lib-tools/OptionParser'
import type { SerialPort } from 'serialport'

import { EventEmitter, once } from 'node:events'
import { createConnection } from 'node:net'

import { toHexString, toJsonMap } from 'hb-lib-tools'
import { toHost, toHostString, toInt, toPath } from 'hb-lib-tools/OptionParser'

const PORT: integer = 2000
const TIMEOUT: integer = 5
const TIMEOUT_DSMR22: integer = 50

export interface PortInfo {
  path: path,
  manufacturer?: string,
  serialNumber?: string,
  pnpId?: string,
  locationId?: string,
  vendorId?: string,
  productId?: string
}

// ===== Telegram Parsing ======================================================

function parseVersion (value: string): string {
  const a = /^\((?<major>\d)(?<minor>\d)(?:\d){0,3}\)$/.exec(value)
  if (a?.groups == null) {
    throw new Error(`${value}: cannot parse version`)
  }
  const { major, minor } = a.groups as Record<string, string>
  return `${major}.${minor}`
}

function parseTimestamp (value: string): string {
  const a = /^\((?<y>\d\d)(?<M>\d\d)(?<d>\d\d)(?<h>\d\d)(?<m>\d\d)(?<s>\d\d)(?<tz>S|W)?\)$/.exec(value)
  if (a?.groups == null) {
    throw new Error(`${value}: cannot parse timestamp`)
  }
  const { y, M, d, h, m, s } = a.groups as Record<string, string>
  return `20${y}-${M}-${d}T${h}:${m}:${s}`
  // const offset = tz === 'S' ? 2 : 1
  // return `20${y}-${M}-${d}T${h}:${m}:${s}+0${offset}:00`
}

function parseString (value: string): string {
  const a = value.match(/\d\d/g)
  return a == null
    ? ''
    : a.reduce((s, c) => s + String.fromCharCode(parseInt(c, 16)), '')
}

function parseValue (value: string): number {
  const a = /^\((?<val>\d*(?:\.\d+)?)(?:\*(?<unit>.+))?\)$/.exec(value)
  if (a?.groups == null) {
    throw new Error(`${value}: cannot parse value`)
  }
  const { val, unit } = a.groups as Record<string, string | null>
  if (val == null) {
    throw new Error(`${value}: missing value`)
  }
  switch (unit ?? 's') {
    case 's':
    case 'kWh':
    case 'V':
    case 'A':
    case 'm3':
      return parseFloat(val)
    case 'kW':
      return Math.round(parseFloat(val) * 1000)
    default:
      throw new Error(`${unit}: unknown unit`)
  }
}

function parseBreaker (value: string): string {
  switch (parseValue(value)) {
    case 0:
      return 'disconnected'
    case 1:
      return 'connected'
    case 2:
      return 'ready'
    default:
      throw new Error(`${value}: unknown breaker value`)
  }
}

function parseType (value: string): string {
  const type = parseValue(value)
  switch (type) {
    /* eslint-disable @typescript-eslint/no-magic-numbers -- no */
    case 2: return 'electricity2'
    case 3: return 'gas'
    case 4: return 'heat'
    case 7: return 'water'
    default: return `d${type}`
    /* eslint-enable @typescript-eslint/no-magic-numbers */
  }
}

function parseLog (values: string[]): Record<string, number> {
  const log: Record<string, number> = {}
  const entries = parseValue(values[0])
  for (let i = 1; i <= entries; i += 1) {
    const date = parseTimestamp(values[2 * i])
    const duration = parseValue(values[2 * i + 1])
    log[date] = duration
  }
  return log
}

function parseAvgPowerPeak (values: string[]): { power: number, time: string } {
  return {
    power: parseValue(values[1]),
    time: parseTimestamp(values[0])
  }
}

function parseAvgPowerPeaks (values: string[]): Array<{ power: number, time: string }> {
  const peaks = []
  const entries = parseValue(values[0])
  for (let i = 1; i <= entries; i += 1) {
    peaks.push({
      power: parseValue(values[3 * i + 2]), // eslint-disable-line @typescript-eslint/no-magic-numbers -- no
      time: parseTimestamp(values[3 * i + 1]) // eslint-disable-line @typescript-eslint/no-magic-numbers -- no
    })
  }
  return peaks
}

interface P1Key {
  key?: string,
  f?: ((value: string) => string | number),
  fa?: ((value: string[]) => Record<string, string | number> | Array<Record<string, string | number>>)
}

const p1Keys: Record<string, P1Key[]> = {
  '0-0:1.0.0': [{ key: 'lastupdated', f: parseTimestamp }],
  '0-0:17.0.0': [{ key: 'max_power', f: parseValue }], // be
  '0-0:96.1.1': [{ key: 'id', f: parseString }],
  '0-0:96.1.4': [{ key: 'version_be', f: parseVersion }], // be
  '0-0:96.3.10': [{ key: 'breaker', f: parseBreaker }], // be
  '0-0:96.7.9': [{ key: 'failures_long', f: parseValue }],
  '0-0:96.7.21': [{ key: 'failures_short', f: parseValue }],
  '0-0:96.13.0': [{ key: 'msg_text', f: parseString }],
  '0-0:96.13.1': [{ key: 'msg_num', f: parseString }], // v22, v42
  '0-0:96.14.0': [{ key: 'tariff', f: parseValue }],
  '0-0:98.1.0': [{ key: 'avg_power_peaks', fa: parseAvgPowerPeaks }], // be

  '0-1:24.1.0': [{ key: 'd1_type', f: parseType }],
  '0-1:24.2.1': [
    { key: 'd1_lastupdated', f: parseTimestamp },
    { key: 'd1_consumption', f: parseValue }
  ],
  '0-1:24.2.3': [ // be gas
    { key: 'd1_lastupdated', f: parseTimestamp },
    { key: 'd1_consumption', f: parseValue }
  ],
  '0-1:24.3.0': [ // v22
    { key: 'd1_lastupdated', f: parseTimestamp },
    {},
    {},
    {},
    {},
    {},
    { key: 'd1_consumption', f: parseValue }
  ],
  '0-1:24.4.0': [{ key: 'd1_breaker', f: parseBreaker }], // be
  '0-1:96.1.0': [{ key: 'd1_id', f: parseString }],
  '0-1:96.1.1': [{ key: 'd1_id', f: parseString }],

  '0-2:24.1.0': [{ key: 'd2_type', f: parseType }],
  '0-2:24.2.1': [
    { key: 'd2_lastupdated', f: parseTimestamp },
    { key: 'd2_consumption', f: parseValue }
  ],
  '0-2:24.2.3': [ // be gas
    { key: 'd2_lastupdated', f: parseTimestamp },
    { key: 'd2_consumption', f: parseValue }
  ],
  '0-2:24.3.0': [ // v22
    { key: 'd2_lastupdated', f: parseTimestamp },
    {},
    {},
    {},
    {},
    {},
    { key: 'd2_consumption', f: parseValue }
  ],
  '0-2:24.4.0': [{ key: 'd2_breaker', f: parseBreaker }], // be
  '0-2:96.1.0': [{ key: 'd2_id', f: parseString }],
  '0-2:96.1.1': [{ key: 'd2_id', f: parseString }],

  '0-3:24.1.0': [{ key: 'd3_type', f: parseType }],
  '0-3:24.2.1': [
    { key: 'd3_lastupdated', f: parseTimestamp },
    { key: 'd3_consumption', f: parseValue }
  ],
  '0-3:24.2.3': [ // be gas
    { key: 'd3_lastupdated', f: parseTimestamp },
    { key: 'd3_consumption', f: parseValue }
  ],
  '0-3:24.3.0': [ // v22
    { key: 'd3_lastupdated', f: parseTimestamp },
    {},
    {},
    {},
    {},
    {},
    { key: 'd3_consumption', f: parseValue }
  ],
  '0-3:24.4.0': [{ key: 'd3_breaker', f: parseBreaker }], // be
  '0-3:96.1.0': [{ key: 'd3_id', f: parseString }],
  '0-3:96.1.1': [{ key: 'd3_id', f: parseString }],

  '0-4:24.1.0': [{ key: 'd4_type', f: parseType }],
  '0-4:24.2.1': [
    { key: 'd4_lastupdated', f: parseTimestamp },
    { key: 'd4_consumption', f: parseValue }
  ],
  '0-4:24.2.3': [ // be gas
    { key: 'd4_lastupdated', f: parseTimestamp },
    { key: 'd4_consumption', f: parseValue }
  ],
  '0-4:24.3.0': [
    { key: 'd4_lastupdated', f: parseTimestamp },
    {},
    {},
    {},
    {},
    {},
    { key: 'd4_consumption', f: parseValue }
  ],
  '0-4:24.4.0': [{ key: 'd4_breaker', f: parseBreaker }], // be
  '0-4:96.1.0': [{ key: 'd4_id', f: parseString }],
  '0-4:96.1.1': [{ key: 'd4_id', f: parseString }],

  '1-0:1.4.0': [{ key: 'avg_power', f: parseValue }], // be
  '1-0:1.6.0': [{ key: 'avg_power_peak', fa: parseAvgPowerPeak }], // be
  '1-0:1.7.0': [{ key: 'power', f: parseValue }],
  '1-0:1.8.1': [{ key: 'consumption_t1', f: parseValue }],
  '1-0:1.8.2': [{ key: 'consumption_t2', f: parseValue }],
  '1-0:2.7.0': [{ key: 'power_back', f: parseValue }],
  '1-0:2.8.1': [{ key: 'consumption_back_t1', f: parseValue }],
  '1-0:2.8.2': [{ key: 'consumption_back_t2', f: parseValue }],

  '1-0:21.7.0': [{ key: 'l1_power', f: parseValue }],
  '1-0:22.7.0': [{ key: 'l1_power_back', f: parseValue }],
  '1-0:31.4.0': [{ key: 'max_current', f: parseValue }],
  '1-0:31.7.0': [{ key: 'l1_current', f: parseValue }],
  '1-0:32.7.0': [{ key: 'l1_voltage', f: parseValue }],
  '1-0:32.32.0': [{ key: 'l1_sags', f: parseValue }],
  '1-0:32.36.0': [{ key: 'l1_swells', f: parseValue }],

  '1-0:41.7.0': [{ key: 'l2_power', f: parseValue }],
  '1-0:42.7.0': [{ key: 'l2_power_back', f: parseValue }],
  '1-0:51.7.0': [{ key: 'l2_current', f: parseValue }],
  '1-0:52.7.0': [{ key: 'l2_voltage', f: parseValue }],
  '1-0:52.32.0': [{ key: 'l2_sags', f: parseValue }],
  '1-0:52.36.0': [{ key: 'l2_swells', f: parseValue }],

  '1-0:61.7.0': [{ key: 'l3_power', f: parseValue }],
  '1-0:62.7.0': [{ key: 'l3_power_back', f: parseValue }],
  '1-0:71.7.0': [{ key: 'l3_current', f: parseValue }],
  '1-0:72.7.0': [{ key: 'l3_voltage', f: parseValue }],
  '1-0:72.32.0': [{ key: 'l3_sags', f: parseValue }],
  '1-0:72.36.0': [{ key: 'l3_swells', f: parseValue }],

  '1-0:99.97.0': [{ key: 'log', fa: parseLog }],

  '1-3:0.2.8': [{ key: 'version', f: parseVersion }] // nl
}

interface Flat extends Record<string, json | undefined> {
  type: string,
  checksum?: string,

  lastupdated?: string,
  max_power?: number,
  id?: string,
  version_be?: string
  breaker?: string,
  failures_long?: number
  failures_short?: number,
  msg_text?: string,
  msg_num?: string,
  tariff?: number,
  avg_power_peaks?: Array<{ power: number, time: string }>

  d1_type?: string,
  d1_lastupdated?: string,
  d1_consumption?: number,
  d1_breaker?: string,
  d1_id?: string,
  
  d2_type?: string,
  d2_lastupdated?: string,
  d2_consumption?: number,
  d2_breaker?: string,
  d2_id?: string,
  
  d3_type?: string,
  d3_lastupdated?: string,
  d3_consumption?: number,
  d3_breaker?: string,
  d3_id?: string,
  
  d4_type?: string,
  d4_lastupdated?: string,
  d4_consumption?: number,
  d4_breaker?: string,
  d4_id?: string,

  avg_power?: number,
  avg_power_peak?: { power: number, time: string },
  power?: number,
  consumption_t1?: number,
  consumption_t2?: number,
  power_back?: number,
  consumption_back_t1?: number,
  consumption_back_t2?: number,

  l1_power?: number,
  l1_power_back?: number,
  max_current?: number,
  l1_current?: number,
  l1_voltage?: number,
  l1_sags?: number,
  l1_swells?: number,

  l2_power?: number,
  l2_power_back?: number,
  l2_current?: number,
  l2_voltage?: number,
  l2_sags?: number,
  l2_swells?: number,

  l3_power?: number,
  l3_power_back?: number,
  l3_current?: number,
  l3_voltage?: number,
  l3_sags?: number,
  l3_swells?: number,

  log?: Record<string, number>,

  version?: string
}

export interface Telegram extends jsonMap {
  electricity: jsonMap,
  electricityBack: jsonMap,
}

function isTelegram (value: jsonMap): value is Telegram {
  return (
    'electricity' in value &&
    'electricityBack' in value
  )
}

function toTelegram (value: unknown): Telegram {
  const json = toJsonMap(value) ?? {}
  if (isTelegram(json)) {
    return json
  }
  const t: Telegram = { electricity: {}, electricityBack: {} }
  return t
}

function crc16 (s: string): number {
  const b = Buffer.from(s, 'utf8')
  let crc = 0
  for (const byte of b) {
    crc ^= byte
    for (let j = 8; j > 0; j -= 1) {
      if ((crc & 0x0001) === 0) {
        crc >>= 1
      } else {
        crc >>= 1
        crc ^= 0xA001 // eslint-disable-line @typescript-eslint/no-magic-numbers -- no
      }
    }
  }
  return crc
}

// ===== P1Client ==============================================================

/** Check whether a discovered serial port could be a USB P1 converter cable.
  * @param {Port} port - The port object as returned by `SerialPort.list()`
  * @returns {boolean} - True if the USB signature matches.
  */
export function isP1 (port: PortInfo): boolean {
  if (
    (port.vendorId === '0403' && port.productId === '6001') ||
    (port.vendorId === '067b' && port.productId === '2303') // Issue #7
  ) {
    return true
  }
  return false
}

/** {@link P1Client} options. */
export interface Options extends Record<string, unknown> {
  /** Use DSMR v2.2 settings for the serial interface: 7N1 at 9600 baud
    * instead of 8N1 at 115200 baud.  Use at least 50s as timeout.
    */
  dsmr22: boolean,
  /** Logger instance to log to. */
  logger?: Logger,
  /** Hostname and port of the (local or remote) ser2net server exposing the serial port device of the P1 USB cable.
   * Default: none - use serial port device.
   */
  host?: host,
  /** The path to the serial port device of the P1 USB cable.  Default: none - use automatic detection. */ 
  serialPort?: path,
  /** Timeout in seconds for closing the connection when no telegram is received.  Default: 5. */
  timeout: integer
}
/** {@link P1Client} events. */
export interface Events {
  /** Emitted when a new telegram is received from the smart meter. */
  data: [
    /** The parsed telegram. */
    data: Telegram
  ]
}

/** Class for P1 serial port client.
  *
  * The DSMR standard defines the P1 interface for end consumers of smart
  * electricity meters provided by electricity network companies in the
  * Netherlands.
  * For details, see the
  * [P1 Companion Standard](https://www.netbeheernederland.nl/_upload/Files/Slimme_meter_15_a727fce1f1.pdf).
  *
  * In essence, the P1 interface is a serial port interface over an RJ11 socket,
  * with some non-standard pin assignments.
  * The easiest way to connect the smart meter to your computer is through a
  * USB P1 converter cable with a built-in FTDI serial port.
  * `P1Client` interfaces to the P1 using this serial port device.
  *
  * To open a connection to the serial port, call {@link P1Client#open open()}.
  * When `options.serialPort` hasn't been set,
  * `SerialPort.list()` is called to attempt automatic
  * discovery of the serial port.
  *
  * The connection is closed automatically when no telegram is received
  * for `options.timeout` seconds, since the connection was opened or the
  * last telegram was received.
  * The connection can be closed explicitly by calling
  * {@link P1Client#close close()}.
  *
  * Once connected, the smart meter sends a telegram on the P1 interface
  * every one (DSMR 5.0) to ten seconds (older DSMR versions).
  * `P1Client` validates and parses these telegrams into JavaScript objects,
  * emitting events as it proceeds.
  *
  * `P1Client` extends [EventEmitter](https://nodejs.org/docs/latest-v24.x/api/events.html#class-eventemitter).
  * @extends EventEmitter
  */
class P1Client extends EventEmitter<Events> {
  private readonly options: Options
  private p1?: Socket | SerialPort
  private s: string
  private firstTelegram: boolean
  private timeout?: NodeJS.Timeout

  /** Create a new instance P1 serial port client. */
  constructor (params: Partial<Options> = {}) {
    super()
    this.options = {
      dsmr22: params.dsmr22 ?? false,
      logger: params.logger,
      host: (params.host === undefined) ? undefined : toHostString(params.host, { key: 'params.host' }),
      serialPort: (params.serialPort === undefined) ? undefined : toPath(params.serialPort, { key: 'params.serialPort' }),
      timeout: params.timeout == null
        ? TIMEOUT
        : toInt(params.timeout, { key: 'params.timeout', min: 1, max: 60 })
    }
    this.s = ''
    this.firstTelegram = true
    if (this.options.dsmr22 && this.options.timeout < TIMEOUT_DSMR22) {
      this.options.timeout = TIMEOUT_DSMR22
    }
  }

  private warn (format: unknown, ...args: unknown[]): void {
    this.options.logger?.warn(format, ...args)
  }

  private debug (format: unknown, ...args: unknown[]): void {
    this.options.logger?.debug(format, ...args)
  }

  private vdebug (format: unknown, ...args: unknown[]): void {
    this.options.logger?.vdebug(format, ...args)
  }

  // private vvdebug (format: unknown, ...args: unknown[]): void {
  //   this.options.logger?.vvdebug(format, ...args)
  // }


  /** Find the path to the serial port device of the USB P1 converter cable.
    * @return The path to the (first) serial port device that
    * matches the USB signature of a USB P1 converter cable.
    * @throws When no USB P1 converter cable was found.
    */
  #findPort (ports: PortInfo[]): path {
    this.debug('ports: %j', ports)
    for (const port of ports) {
      if (isP1(port)) {
        return port.path
      }
    }
    throw new Error('USB P1 converter cable not found')
  }

  /** Open the connection to the serial port.
    *
    * When the connection has been established, an `open` event is emitted.
    * When no data has been received for `options.timeout` seconds, the
    * connection is closed automatically.
    * @throws `Error` - When serial port cannot be found or opened.
    */
  async open (): Promise<void> {
    this.s = ''
    this.firstTelegram = true
    let serialPort = ''
    if (this.options.host == null) {
      this.warn(
        'loading "serialport" library, see https://github.com/ebaauw/homebridge-p1/issues/84'
      )
      const { SerialPort } = await import('serialport')
      if (this.options.serialPort == null) {
        const ports = await SerialPort.list()
        this.options.serialPort = this.#findPort(ports)
      }
      serialPort = this.options.serialPort // eslint-disable-line @typescript-eslint/prefer-destructuring -- no
      // TODO figure out type of SerialPort constructor options
      // const options: SerialPortOpenOptions<AutoDetectTypes> = this.options.dsmr22
      //   ? { baudRate: 9600, dataBits: 7, parity: 'even' } // 9600 7E1
      //   : { baudRate: 115200 } // 115200 8N1
      this.#setTimeout()
      if (this.options.dsmr22) {
        // 9600 7E1
        this.p1 = new SerialPort({ path: this.options.serialPort, baudRate: 9600, dataBits: 7, parity: 'even' })
      } else {
        // 115200 8N1
        this.p1 = new SerialPort({ path: this.options.serialPort, baudRate: 115200 })
      } 
      await once(this.p1, 'open')
    } else {
      serialPort = this.options.host // eslint-disable-line @typescript-eslint/prefer-destructuring -- no
      const { hostname, port } = toHost(this.options.host)
      this.#setTimeout()
      this.p1 = createConnection(port ?? PORT, hostname)
      await once(this.p1, 'ready')
    }
    this.p1
      .on('data', (buffer: Buffer) => {
        this.#setTimeout()
        this.s += buffer.toString()
        let start, end
        while ((start = this.s.indexOf('/')) !== -1) {
          if ((end = this.s.indexOf('!', start)) === -1) {
            break
          }
          if ((end = this.s.indexOf('\r\n', end)) === -1) {
            break
          }
          this.parseTelegram(this.s.slice(start, end + 2))
          this.s = this.s.slice(end + 3) // eslint-disable-line @typescript-eslint/no-magic-numbers -- no
        }
      })
      .on('close', () => {
        this.p1?.removeAllListeners()
        delete this.p1
        this.debug('disconnected from %s', serialPort)
      })
      .on('error', (error) => { this.warn(error) })
    this.debug('connected to %s', serialPort)
  }

  /** Check if the connection to the serial port is open.
    */
  isOpen (): boolean {
    return this.p1 != null
  }

  /** Close the connection to the serial port.
    */
  close (): void {
    if (this.p1 != null) {
      if ('destroy' in this.p1 && typeof this.p1.destroy === 'function') {
        this.p1.destroy()
      }
    }
  }

  /** Set a new timeout on receiving the next telegram.
    *
    * Any existing timeout is cancelled, before the new timeout is set.
    * When no telegram has been received for `options.timeout` seconds, the
    * connection to the serial port is closed automatically.
    */
  #setTimeout (): void {
    if (this.timeout != null) {
      clearTimeout(this.timeout)
    }
    this.timeout = setTimeout(() => {
      if (this.p1 != null) {
        this.warn(`no data received in ${this.options.timeout}s`)
        this.close()
      }
    }, this.options.timeout * 1000)
  }

  #parse (telegram: string): Flat | undefined {
    let a = /\/(?<header>.+)\r\n\r\n(?<lines>(?:\d+-\d+:\d+\.\d+\.\d+(?:\(.*\)\r?\n?)+\r\n)*)(?<footer>!(?:[0-9A-F]{4})?)\r\n/.exec(telegram)
    if (a?.groups == null) {
      this.warn('ignoring invalid telegram')
      return
    }
    const { groups } = a
    const { header, lines, footer } = groups
    const c = footer.substring(1)
    if (c !== '') {
      const checksum = parseInt(c, 16)
      const crc = crc16(telegram.slice(0, -6)) // eslint-disable-line @typescript-eslint/no-magic-numbers -- no
      if (checksum !== crc) {
        const received = toHexString(crc, { length: 4 })
        this.warn(
          `ignoring telegram with crc error (got: ${received}, expected: ${c})`
        )
        return
      }
    }
    const result: Flat = { type: header, checksum: c }
    const r = /(?<k>\d+-\d+:\d+\.\d+\.\d+)(?<v>(?:\(.*\)\r?\n?)+)\r\n/g
    do {
      a = r.exec(lines)
      if (a?.groups == null) {
        continue
      }
      const { groups } = a
      const { k, v } = groups
      if (!(k in p1Keys)) {
        this.debug(`${k}: ignoring unknown key`)
        continue
      }
      const rv = /(?<v>\([^)]*\))/g
      let av
      const values: string[] = []
      do {
        av = rv.exec(v)
        if (av?.groups?.v != null) {
          values.push(av.groups.v)
        }
      } while (av != null)

      p1Keys[k].forEach(({ key, f, fa }) => {
        try {
          if (key === undefined) {
            values.shift()
            return
          }
          if (f !== undefined) {
            result[key] = f(values.shift() ?? '')
          } else if (fa !== undefined) {
            result[key] = fa(values)
          }
        } catch (error) {
          this.debug('%s: ignoring %s', k, error)
        }
      })
    } while (a != null)
    return result
  }

  /** Parse a telegram.
    *
    * Normally this method is called automatically, when a telegram is received
    * from the P1 interface.
    * It can also be called manually to have P1Cient emit events for a fake
    * telegram (e.g. for testing).
    */
  parseTelegram (telegram: string): Telegram | undefined{ // eslint-disable-line complexity -- no
    const debug = this.firstTelegram ? this.debug.bind(this) : this.vdebug.bind(this)
    this.firstTelegram &&= false
    debug('telegram:\n%s', telegram)

    try {
      const obj = this.#parse(telegram)
      if (obj == null) {
        return
      }
      debug('raw data: %j', obj)

      // Convert the flat object into a cooked object.
      const be = obj.version_be != null
      const low = be ? 2 : 1
      const normal = be ? 1 : 2
      const tariff = obj.tariff === low ? 'low' : 'normal'
      if (obj.avg_power_peak != null) {
        obj.avg_power_peaks ??= []
        obj.avg_power_peaks.push(obj.avg_power_peak)
      }
      const result: Record<string, unknown> & {
        electricity: Record<string, unknown>
        electricityBack: Record<string, unknown>
      } = {
        type: obj.type,
        version: obj.version_be ?? obj.version ?? '2.2',
        msg_text: obj.msg_text,
        msg_num: obj.msg_num,
        electricity: {
          id: obj.id?.trim(),
          lastupdated: obj.lastupdated,
          tariff,
          consumption: {
            low: obj[`consumption_t${low}`],
            normal: obj[`consumption_t${normal}`]
          },
          power: obj.power,
          avg_power: obj.avg_power,
          avg_power_peaks: obj.avg_power_peaks,
          breaker: obj.breaker,
          failures: {
            short: obj.failures_short,
            long: obj.failures_long,
            log: obj.log
          }
        },
        electricityBack: {
          id: `${obj.id?.trim()}B`,
          lastupdated: obj.lastupdated,
          tariff,
          consumption: {
            low: obj[`consumption_back_t${low}`],
            normal: obj[`consumption_back_t${normal}`]
          },
          power: obj.power_back
        }
      }

      for (const l of ['l1', 'l2', 'l3']) {
        const { [`${l}_power_back`]: powerBack } = obj
        if ((l !== 'l1' && obj[`${l}_power`] == null) || typeof powerBack !== 'number') {
          continue
        }
        result.electricity[l] = {
          voltage: obj[`${l}_voltage`],
          sags: obj[`${l}_sags`],
          swells: obj[`${l}_swells`],
          current: powerBack > 0 ? 0 : obj[`${l}_current`],
          power: obj[`${l}_power`]
        }
        result.electricityBack[l] = {
          voltage: obj[`${l}_voltage`],
          current: powerBack > 0 ? obj[`${l}_current`] : 0,
          power: powerBack
        }
      }

      for (const d of ['d1', 'd2', 'd3', 'd4']) {
        const { [`${d}_type`]: type, [`${d}_id`]: id } = obj
        if (typeof type !== 'string' || typeof id !== 'string' || obj[`${d}_lastupdated`] == null || obj[`${d}_consumption`] == null) {
          continue
        }
        result[type] = {
          id: id.trim(),
          lastupdated: obj[`${d}_lastupdated`],
          consumption: obj[`${d}_consumption`],
          breaker: obj[`${d}_breaker`]
        }
      }

      const res = toTelegram(result)
      this.debug('data: %j', res)
      this.emit('data', res)
      return res
    } catch (error) {
      this.warn(error)
    }
  }
}

export { P1Client }

// hb-p1-tools/src/P1Tool.ts
//
// Homebridge P1 Tools.
// Copyright © 2020-2026 Erik Baauw. All rights reserved.

/** The `p1` command line tool.
  * Issue `p1 -h` for more info.
  * @module
  */

import type { integer, jsonMap } from 'hb-lib-tools'
import type { Mode } from 'hb-lib-tools/CommandLineTool'

import { timeout } from 'hb-lib-tools'
import { CommandLineTool, CommandLineParser, b, u } from 'hb-lib-tools/CommandLineTool'
import { JsonFormatter } from 'hb-lib-tools/JsonFormatter'
import { toHostString, toInt, toString } from 'hb-lib-tools/OptionParser'

import { P1Client } from 'hb-p1-tools/P1Client'

import defaultPackageJson from '../package.json' with { type: 'json' }

const CLOSE_TIMEOUT = 500

const usage = `${b('ws')} [${b('-hVDds')}] [${b('-H')} ${u('hostname')}${b(':')}${u('port')}] [${b('-t')} ${u('timeout')}]`
const help = `P1 tool.

Usage: ${usage}

Log data received from the P1 port.

Parameters:
  ${b('-h')}, ${b('--help')}
  Print this help and exit.

  ${b('-V')}, ${b('--version')}
  Print version and exit.
  
  ${b('-D')}, ${b('--debug')}
  Print debug messages.

  ${b('-d')}, ${b('--daemon')}
  Run as daemon.

  ${b('-s')}, ${b('--service')}
  Run as service.  Do not output timestamps.

  ${b('-H')} ${u('hostname')}${b(':')}${u('port')}, ${b('--host=')}${u('hostname')}${b(':')}${u('port')}
  Connect to the serial port over ${b('ser2net')} at ${u('hostname')}${b(':')}${u('port')}.
  Default: connect to the auto discovered P1 USB cable.

  ${b('-t')} ${u('timeout')}, ${b('--timeout=')}${u('timeout')}
  Set timeout to ${u('timeout')} seconds instead of default ${b('15')}.`

/** @ignore */
class P1Tool extends CommandLineTool {
  protected _packageJson: jsonMap
  options: {
    mode?: Mode
    dsmr22: boolean
    host?: string
    serialPort?: string
    test?: string
    timeout: integer
  }
  private p1?: P1Client
  
  constructor (packageJson?: jsonMap) {
    super()
    this._packageJson = packageJson ?? defaultPackageJson
    this.usage = usage
    this.options = {
      dsmr22: false,
      timeout: 15
    }
  }

  parseArguments (): void {
    const parser = new CommandLineParser(this)
    parser
      .helpFlag('h', 'help', help)
      .versionFlag('V', 'version')
      .debugFlag('D', 'debug')
      .flag('d', 'daemon', () => { this.options.mode = 'daemon' })
      .flag('s', 'service', () => { this.options.mode = 'service' })
      .option('H', 'host', (value) => {
        this.options.host = toHostString(value, { key: 'host', userInput: true  })
      })
      .flag('2', 'dsmr22', () => { this.options.dsmr22 = true })
      .option('T', 'test', (value) => {
        this.options.test = toString(value, { key: 'test', nonEmpty: true, userInput: true })
      })
      .option('t', 'timeout', (value) => {
        this.options.timeout = toInt(value, { key: 'timeout', min: 1, max: 60, userInput: true })
      })
      .parse()
  }

  async main (): Promise<void> {
    try {
      this.parseArguments()
      this.p1 = new P1Client({
        dsmr22: this.options.dsmr22,
        logger: this,
        host: this.options.host,
        serialPort: this.options.serialPort,
        timeout: this.options.timeout
      })
      const formatter = new JsonFormatter(
        this.options.mode === 'service'
          ? { noWhiteSpace: true, sortKeys: true }
          : { sortKeys: true }
      )
      if (this.options.mode != null) {
        this.setOptions({ mode: this.options.mode })
      }
      this.p1.on('data', (data) => { this.log(formatter.stringify(data)) })
      if (this.options.test != null) {
        const { telegrams } = await import('hb-p1-tools/telegrams')
        if (!(this.options.test in telegrams)) {
          this.error('%s: unknown test telegram', this.options.test)
          return
        }
        this.p1.parseTelegram(telegrams[this.options.test])
        return
      }
      await this.p1.open()
    } catch (error) {
      this.error(error)
    }
  }

  async destroy (): Promise<void> {
    this.p1?.close()
    await timeout(CLOSE_TIMEOUT)
  }
}

export { P1Tool }

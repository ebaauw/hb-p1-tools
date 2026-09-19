import { JsonFormatter } from 'hb-lib-tools/JsonFormatter'
import { P1Client } from 'hb-p1-tools/P1Client'
import { telegrams } from 'hb-p1-tools/telegrams'

const formatter = new JsonFormatter({ sortKeys: true })
const p1 = new P1Client()
const result = {}
for (const [k, v] of Object.entries(telegrams)) {
  result[k] = {
    input: v,
    output: p1.parseTelegram(v)
  }
}

console.log(formatter.stringify(result))

// Synthetic MySkoda charging-history export (no real data). BOM, CRLF line
// endings, every field quoted, a comma inside a quoted location, and a trailing
// empty line, so node and browser tests exercise the real file's quirks.
const LINES = [
  '"Session ID","Started on","Ended on","Charging time (s)","Actual charging time (s)","Total energy (kWh)","Battery energy (kWh)","""Comfort"" energy (kWh)","Start SOC (%)","End SOC (%)","Total price","Energy price","Blocking fees","Voucher amount used","Location name","Charging location"',
  '"s-1","2026-02-10T11:00:00Z","2026-02-10T13:00:00Z","7200","7000","12.00","","","20.00","45.00","","","","","",""',
  '"s-2","2026-03-01T08:00:00Z","2026-03-01T09:30:00Z","5400","5400","8.00","","","50.00","70.00","","","","","",""',
  '"s-3","2026-03-05T12:00:00Z","2026-03-05T12:40:00Z","2400","2400","30.00","","","10.00","80.00","199.00","","","","Laddplats, Testgatan 1",""',
  '"s-4","n/a","2026-03-06T10:00:00Z","0","0","1.00","","","","","","","","","",""',
]

export const SKODA_EXPORT_FIXTURE: string = `﻿${LINES.join('\r\n')}\r\n`

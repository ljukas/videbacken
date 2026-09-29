import { MoreVerticalIcon, PencilIcon, PlusIcon, ReceiptTextIcon, Trash2Icon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty'
import { RowActions } from '~/components/ui/row-actions'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { m } from '~/paraglide/messages'
import { formatDay, formatDecimal } from './format'
import type { Tariff } from './TariffDialog'

type Props = {
  /** Oldest first, as `tariff.list` returns them. */
  tariffs: Tariff[]
  /** Admin actions; omitted for everyone else (the card is then read-only). */
  admin?: {
    onNew: () => void
    onEdit: (id: string) => void
    onDelete: (id: string) => void
  }
}

// The per-kWh fees the cost is computed from, newest period first. Everyone
// can see them (the cost is only as trustworthy as these numbers); only
// admins get the add/edit/delete actions. Empty → the shared `Empty`
// (ADR-0016), with the one next action for admins.
export function TariffCard({ tariffs, admin }: Props) {
  const newestFirst = [...tariffs].reverse()
  const ore = (v: number) => `${formatDecimal(v)} öre`
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.charging_tariff_title()}</h2>
        </CardTitle>
        <CardDescription>{m.charging_tariff_description()}</CardDescription>
        {admin && tariffs.length > 0 ? (
          <CardAction>
            <Button variant="outline" size="sm" onClick={admin.onNew}>
              <PlusIcon />
              {m.charging_tariff_new()}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {tariffs.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ReceiptTextIcon />
              </EmptyMedia>
              <EmptyTitle>{m.charging_tariff_empty_title()}</EmptyTitle>
              <EmptyDescription>
                {admin
                  ? m.charging_tariff_empty_description_admin()
                  : m.charging_tariff_empty_description()}
              </EmptyDescription>
            </EmptyHeader>
            {admin ? (
              <EmptyContent>
                <Button size="sm" onClick={admin.onNew}>
                  <PlusIcon />
                  {m.charging_tariff_new()}
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.charging_tariff_col_valid_from()}</TableHead>
                <TableHead className="text-right">{m.charging_tariff_col_markup()}</TableHead>
                <TableHead className="text-right">{m.charging_tariff_col_grid()}</TableHead>
                <TableHead className="hidden text-right sm:table-cell">
                  {m.charging_tariff_col_tax()}
                </TableHead>
                <TableHead className="hidden text-right sm:table-cell">
                  {m.charging_tariff_col_vat()}
                </TableHead>
                {admin ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {newestFirst.map((t) => (
                <TableRow key={t.id} className="group/row">
                  <TableCell className="whitespace-nowrap">{formatDay(t.validFrom)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {ore(t.retailMarkupOre)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {ore(t.gridTransferOre)}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {ore(t.energyTaxOre)}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {`${formatDecimal(t.vatPercent)} %`}
                  </TableCell>
                  {admin ? (
                    <TableCell className="text-right">
                      <RowActions>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={m.charging_tariff_actions_for({
                                date: formatDay(t.validFrom),
                              })}
                            >
                              <MoreVerticalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => admin.onEdit(t.id)}>
                              <PencilIcon />
                              {m.common_edit()}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => admin.onDelete(t.id)}
                            >
                              <Trash2Icon />
                              {m.charging_tariff_delete_action()}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </RowActions>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

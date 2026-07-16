import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react'
import * as React from 'react'
import * as RPNInput from 'react-phone-number-input'
import flags from 'react-phone-number-input/flags'

import { Button } from '~/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command'
import { Input } from '~/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import { ScrollArea } from '~/components/ui/scroll-area'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type PhoneInputSize = 'default' | 'xl'

type PhoneInputContextValue = {
  size: PhoneInputSize
  // Optional class overrides for the two fused subcontrols, so a wrapper (e.g. the
  // floating-label phone field) can grow them to a taller box than the size variant.
  inputClassName?: string
  countryButtonClassName?: string
}

// react-phone-number-input forwards extra props to the *input* component only, not
// to the country-select component, so we can't thread sizing to both via RPNInput
// props. A small context carries it to both subcomponents instead — keeps the
// country button and number input in lockstep regardless of RPNInput's API.
const PhoneInputContext = React.createContext<PhoneInputContextValue>({ size: 'default' })

type PhoneInputProps = Omit<React.ComponentProps<'input'>, 'onChange' | 'value' | 'ref' | 'size'> &
  Omit<RPNInput.Props<typeof RPNInput.default>, 'onChange'> & {
    onChange?: (value: RPNInput.Value) => void
    size?: PhoneInputSize
    inputClassName?: string
    countryButtonClassName?: string
  }

const PhoneInput: React.ForwardRefExoticComponent<PhoneInputProps> = React.forwardRef<
  React.ComponentRef<typeof RPNInput.default>,
  PhoneInputProps
>(
  (
    {
      className,
      onChange,
      value,
      size = 'default',
      inputClassName,
      countryButtonClassName,
      ...props
    },
    ref,
  ) => {
    const context = React.useMemo<PhoneInputContextValue>(
      () => ({ size, inputClassName, countryButtonClassName }),
      [size, inputClassName, countryButtonClassName],
    )
    return (
      <PhoneInputContext value={context}>
        <RPNInput.default
          ref={ref}
          className={cn('flex', className)}
          flagComponent={FlagComponent}
          countrySelectComponent={CountrySelect}
          inputComponent={InputComponent}
          smartCaret={false}
          value={value || undefined}
          // react-phone-number-input fires onChange with undefined for invalid input;
          // coerce to "" so the bound form keeps a string value.
          onChange={(v) => onChange?.(v || ('' as RPNInput.Value))}
          {...props}
        />
      </PhoneInputContext>
    )
  },
)
PhoneInput.displayName = 'PhoneInput'

const InputComponent = React.forwardRef<HTMLInputElement, React.ComponentProps<typeof Input>>(
  ({ className, ...props }, ref) => {
    const { size, inputClassName } = React.useContext(PhoneInputContext)
    return (
      <Input
        size={size}
        // Match the start side of the fused country button: drop start rounding and
        // mirror the size variant's corner radius on the end side. `inputClassName`
        // (caller override) comes last so it wins.
        className={cn(
          'rounded-s-none',
          size === 'xl' ? 'rounded-e-xl' : 'rounded-e-lg',
          className,
          inputClassName,
        )}
        {...props}
        ref={ref}
      />
    )
  },
)
InputComponent.displayName = 'InputComponent'

type CountryEntry = { label: string; value: RPNInput.Country | undefined }

type CountrySelectProps = {
  disabled?: boolean
  value: RPNInput.Country
  options: CountryEntry[]
  onChange: (country: RPNInput.Country) => void
}

const CountrySelect = ({
  disabled,
  value: selectedCountry,
  options: countryList,
  onChange,
}: CountrySelectProps) => {
  const { size, countryButtonClassName } = React.useContext(PhoneInputContext)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const [searchValue, setSearchValue] = React.useState('')
  const [isOpen, setIsOpen] = React.useState(false)

  return (
    <Popover
      open={isOpen}
      modal
      onOpenChange={(open) => {
        setIsOpen(open)
        if (open) setSearchValue('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={size}
          // Fuse to the number input: round only the start side (mirroring the size
          // variant's radius) and drop the shared border between the two.
          // `countryButtonClassName` (caller override) comes last so it wins.
          className={cn(
            'flex gap-1 rounded-e-none border-r-0 px-3 focus:z-10 focus-visible:border-brand focus-visible:ring-1 focus-visible:ring-brand',
            size === 'xl' ? 'rounded-s-xl' : 'rounded-s-lg',
            countryButtonClassName,
          )}
          disabled={disabled}
        >
          <FlagComponent country={selectedCountry} countryName={selectedCountry} />
          <ChevronsUpDownIcon
            // Keep the chevron in the layout flow even when disabled (e.g. while a
            // form is submitting) — dim it rather than `hidden`, so the country
            // button width stays constant and the field doesn't shift on submit.
            // The floating-label variant relies on this constant width for its
            // fixed `left-[4.5rem]` caption offset.
            className={cn('-mr-2 size-4', disabled ? 'opacity-50' : 'opacity-100')}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0">
        <Command>
          <CommandInput
            value={searchValue}
            onValueChange={(v) => {
              setSearchValue(v)
              setTimeout(() => {
                if (scrollAreaRef.current) {
                  const viewportElement = scrollAreaRef.current.querySelector(
                    '[data-radix-scroll-area-viewport]',
                  )
                  if (viewportElement) {
                    viewportElement.scrollTop = 0
                  }
                }
              }, 0)
            }}
            placeholder={m.form_country_search_placeholder()}
          />
          <CommandList>
            <ScrollArea ref={scrollAreaRef} className="h-72">
              <CommandEmpty>{m.form_country_search_empty()}</CommandEmpty>
              <CommandGroup>
                {countryList.map(({ value: countryValue, label }) =>
                  countryValue ? (
                    <CountrySelectOption
                      key={countryValue}
                      country={countryValue}
                      countryName={label}
                      selectedCountry={selectedCountry}
                      onChange={onChange}
                      onSelectComplete={() => setIsOpen(false)}
                    />
                  ) : null,
                )}
              </CommandGroup>
            </ScrollArea>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

interface CountrySelectOptionProps extends RPNInput.FlagProps {
  selectedCountry: RPNInput.Country
  onChange: (country: RPNInput.Country) => void
  onSelectComplete: () => void
}

const CountrySelectOption = ({
  country,
  countryName,
  selectedCountry,
  onChange,
  onSelectComplete,
}: CountrySelectOptionProps) => {
  const handleSelect = () => {
    onChange(country)
    onSelectComplete()
  }

  return (
    <CommandItem className="gap-2" onSelect={handleSelect}>
      <FlagComponent country={country} countryName={countryName} />
      <span className="flex-1 text-sm">{countryName}</span>
      <span className="text-foreground/50 text-sm">
        {`+${RPNInput.getCountryCallingCode(country)}`}
      </span>
      <CheckIcon
        className={cn('ml-auto size-4', country === selectedCountry ? 'opacity-100' : 'opacity-0')}
      />
    </CommandItem>
  )
}

const FlagComponent = ({ country, countryName }: RPNInput.FlagProps) => {
  const Flag = flags[country]

  return (
    <span className="flex h-4 w-6 overflow-hidden rounded-sm bg-foreground/20 [&_svg:not([class*='size-'])]:size-full">
      {Flag && <Flag title={countryName} />}
    </span>
  )
}

export { PhoneInput }

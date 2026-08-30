# Symulator ectra

Pakiet `ectra` symuluje napęd dla portu `SIM`.
Rejestry wynikają z jednego stanu maszyny, więc kolejne odczyty są ze sobą zgodne.

Ogólny `sim.py` losuje każdy rejestr osobno.
To wystarcza dla nieznanej mapy, ale nie dla napędu, w którym zapis nastawy musi zmienić cały punkt pracy.
Dlatego tylko `names.py` i `binding.py` znają nazwy rejestrów ectry, a `modbus.py` pozostaje ogólny.

## Uruchomienie

Wybór symulatora ustawia `app.ini`:

```ini
sim = ectra
```

Pakiet rejestruje się podczas importu.
`Binding.match` sprawdza mapę rejestrów.
Jeżeli brakuje wymaganych rejestrów, `config.sim_client` używa ogólnego symulatora.

Model można też uruchomić bez aplikacji:

```py
from ectra import Command, Machine, Plant

plant = Plant(Machine(dtcomp=55))
plant.step(Command(target_hz=55, mode="foc", poles=6, rs_ohm=0.9, ke_v_hz=0.58), 0.05)
print(plant.vec, plant.machine.iq)
```

Scenariusz z terminala uruchamia polecenie:

```powershell
py -m ectra [vf|if|foc] [Hz] [s]
```

Scenariusz działa szybciej niż czas rzeczywisty.
Wypisuje zmianę każdego etapu i bilans końcowy.

## Moduły

Zależności między modułami są acykliczne.
Każdy plik ma jedno zadanie:

- `curve.py`: funkcje `interp` i `clamp`
- `command.py`: komenda jednego kroku w jednostkach fizycznych
- `machine.py`: uzwojenie, mostek, wał, kąt obciążenia, szyna i termika
- `ramp.py`: limity, derating, freeze i hold
- `observer.py`: estymacja prędkości, średni błąd kąta i jego obwiednia
- `detector.py`: warunek przejęcia i powrót do I/f z debounce
- `protect.py`: zabezpieczenia i komparator sprzętowy
- `plant.py`: kolejność etapów symulacji
- `meter.py`: warstwy pomiarowe `ctrl` i `view`
- `scope.py`: publikacja szybkich wartości do wolnych rejestrów
- `runner.py`: niezależny wątek maszyny
- `__main__.py`: obsługa scenariusza z terminala
- `names.py` i `binding.py`: nazwy i wiązanie rejestrów
- `client.py`: `SimulatedClient` udostępniający pracującą maszynę

`detector.py` zwraca `Verdict`, a `protect.py` zwraca kod błędu.
Decyzje wykonuje `plant.py`, więc przejęcie i trip można testować osobno.

## Krok symulacji

Stan maszyny zmienia się w czasie i nie zależy od częstotliwości odpytywania.
Odczyt próbkuje stan, a zapis zmienia komendę.

`runner.py` wykonuje krok co `10ms`.
Wewnątrz używa podkroku `1ms`, krótszego od stałej `L/R` uzwojenia około `7ms` i okresu kołysania wirnika około `130ms`.

- Uzwojenie jest rozwiązywane dokładnie na każdym podkroku.
  Człony skrośne tworzą obrót z prędkością elektryczną, więc jawny schemat zmieniałby amplitudę.
- Kąt obciążenia i wał używają metody leapfrog.
  Tłumienie w V/f jest małe, dlatego błąd fazy pełnego kroku mógłby wyglądać jak ujemne tłumienie.
- Pętle prądu dochodzą do celu z pasmem `Foc:CurrBw`.
- Na wał działa moment `kt·iq` i obciążenie.
  Model nie dodaje momentu asynchronicznego, który mógłby obracać maszynę bez prądu.
- `If:Damp` przechyla ramkę i nie dodaje momentu.
  Sygnał jest górnoprzepustowy i ograniczony do ±8°, zgodnie z `clamp(..., -1456, 1456)` w `FOC_Step`.
- `Foc:EntryGlide` prowadzi `id` i `iq` od wektora wejściowego do celów pętli zamkniętej.
  Dzięki temu przejęcie nie powoduje skoku prądu.

Zmiana nastawy daje przebieg przejściowy, a nie skok.
Przy zmianie etapu kąt jest przeliczany, ponieważ `delta` opisuje kąt aktualnie przykładanego wektora.

## Pomiary

`Meas` i `MeasCtrl` filtrują tę samą migawkę z różnymi stałymi czasu.
Stałe wynikają z `MeasCfg:*`.

Okno `256` próbek przy `10kHz` trwa `25.6ms`.
`WindowCtrl = 1` daje dwa okna, a `WindowView = 7` daje 128 okien.

- Prądy, wartości szczytowe i tętnienie: `ctrl` ma τ≈`51ms`, a `view` τ≈`3.3s`.
- Napięcia i temperatury: `ctrl` ma τ≈`3.2ms`, a `view` τ≈`3.3s`.

Zabezpieczenia używają tylko `ctrl`.
Derating używa tylko `view`.

## Publikacja sygnałów

`scope.py` odwzorowuje `foc-sig/diag/scope.c`.
Określa kształt kanału i szybkość jego zaniku.

`SCOPE_Env_t` przechowuje `value << 5` i odejmuje `decay` przy każdym feedzie.
Wartość spada więc o `decay / 32` na feed:

- `Bus:Peak`: `decay = 3` przy `10kHz`, czyli `93.75V/s`
- `Pwm:DutyPeak`: `decay = 1` przy `10kHz`, czyli `9.77%/s`
- `Sync:ErrPeak`: `decay = 700` przy `100Hz`, czyli `21.88°/s`
- `Sync:LockPeak`: `decay = 6` przy `100Hz`, czyli `18.75 tick/s`

`Obs:OmegaHat`, `Obs:AngleErr`, `Obs:Bias`, `Sync:Err` i `Foc:Vd/Vq` są średnimi z `320ms`.
Jest to `shift = 5` na siatce `10ms`, więc odczyt ma to samo znaczenie przy `20Hz` i `55Hz`.
`Bus:Max` zeruje się przy każdym starcie.

> **Nota:** Dyskryminator PLL używa iloczynu wektorowego, dlatego próg trafia do niego jako sinus w Q15: `staged.lock_q15 = sinf(lock_err)`.
> Dolina przejęcia wynosi `err_lock_q15 / 2`, czyli `asin(sin(LockErr) / 2)`, a nie połowę kąta.
> Dla `22°` różnica wynosi `0.2°`, a dla `60°` około `4°`.
> Rejestr używa `(err_n * 5730) >> 15`, więc przy dużym błędzie pokazuje mniej niż rzeczywisty kąt, na przykład `37°` dla `40°`.

## Model maszyny 1500W

Stałe elektryczne pochodzą z końcowego pomiaru w `foc-tests/plant/pmsm.c`.
Stałe mechaniczne wynikają z wartości domyślnych rejestrów, ponieważ stanowisko pomiarowe używa innego wirnika, trzech par biegunów i cztery razy większego strumienia.

| Stała | Wartość | Źródło |
| --- | --- | --- |
| `Rs` | `0.898Ω` | pomiar końcowy |
| `Lq` | `6.27mH` | pomiar końcowy |
| `Ke` | `0.40V/Hz` | tabela `Volt`, zobacz `machine.KE_V_Hz` |
| `kf` | `2.3e-4` | `Speed:Max` musi być osiągalne przy `Foc:IqMax` |
| `J` | `0.056kg·m²` | `Brake:Coast = 90s` przy `50Hz` |

Domyślnym obciążeniem jest wentylator.
Scenariusz może podać inne obciążenie przez konstruktor:

```py
Machine(inertia=0.6, fan=0.0, load_nm=1.0)
```

Taka konfiguracja tworzy koło zamachowe i pozwala obserwować pompowanie szyny.

## Parametry ukryte

Maszyna przechowuje rzeczywiste stałe osobno od ustawień `Motor:*`.
Błędne dane silnika zmieniają pracę obserwatora i pętli, ale nie zmieniają fizycznego modelu.

Dwa parametry nie występują w mapie rejestrów:

- `dtcomp`: rzeczywista strata dead-time mostka.
  `client.py` losuje wartość z zakresu `40-76%`, więc zwykle różni się ona od domyślnego `Obs:DtComp = 60`.
  Różnicę można znaleźć przez `Obs:Bias`.
- `phasemap`: rzeczywiste podłączenie torów prądowych.
  Domyślnie odpowiada `Sense:PhaseMap = invV`.
  Zmiana ustawienia powoduje `Drive:Stage = guard`.

## Odwzorowane zachowania

Model obsługuje wszystkie 11 etapów `Drive:Stage` z `shared.h`, w tym `off`, `shunt`, `obs`, `guard` i `volts`.

Przejęcie FOC działa na kroku `10ms` i używa stałych z `obs.c`:

- licznik potwierdzenia rośnie maksymalnie do `40`
- przy błędzie licznik spada o `4`
- najkrótsze potwierdzenie trwa `400ms`
- resync wymaga trzech zdarzeń w oknie `4s`

Bramka porównuje obwiednię błędu, a nie jego bieżącą wartość.
Wirnik kołysze się wokół kąta obciążenia, licznik zbiera maksimum, a przełączenie następuje w minimum.
Dlatego `Sync:Err` i `Sync:ErrPeak` mają różne wartości.

Model obsługuje zabezpieczenia `peak`, `irms`, `imax`, `temp`, `hv-`, `hv+`, `stall`, `spin` i `sync`.
Każde ma własny debounce.

`stall` działa tylko pod tabelą i tylko podczas wzrostu rampy.
Ma gałąź prądową poniżej `Thresh:StallFreq` oraz gałąź estymaty powyżej `10Hz`, gdy wektor prądu pozostaje poniżej `3Hz`.
Druga gałąź wykrywa niedowzbudzony stall, którego nie wykrywa próg prądowy.

`Feedback:State` pokazuje `str` tylko przez `Drive:AlignTime`.
Potem `RENDER_Run` ustawia `run`, również podczas rampy.
Okno startowe zatrzymuje rampę dla startu zwykłego, catch i werdyktów.

Brak zapasu napięcia, czyli `Foc:Flags = sat`, zatrzymuje wzrost rampy.
Strefy `Resonance:*` przesuwają cel do najbliższej krawędzi pasma z uwzględnieniem `Speed:Min/Max`, zgodnie z `LINK_ResonanceEscape`.

Po błędzie mostek wyłącza się, a wał zwalnia zgodnie z modelem fizycznym.
`Feedback:State` pokazuje `coa` przez czas `Brake:Coast` przeskalowany częstotliwością z chwili błędu.

Rejestry bez modelowanej wartości dostają sentinel z `null_raw`.
Odczyt wskazuje wtedy brak danych zamiast starej lub losowej wartości.

## Tabela V/f

Domyślna tabela `Volt` jest liniowa od `20Hz`: `V = 13.0 + 0.40f`.
Poniżej `20Hz` dodaje boost IR.
Stałe `13V` kompensuje stratę dead-time mostka, dlatego `machine.DEAD_COMP = 0`.
Najmniejszy prąd występuje przy `50Hz`.

> **Uwaga:** Start w `Drive:Mode = vf` na ustawieniach domyślnych ma mały zapas.
> Tabela podaje `17.1V`, mostek traci około `13.3V`, a reszta przy `0.9Ω` daje do `4.3A`.
> Próg `Thresh:CurrRms` wynosi `5A`.
> Obniżenie `Volt:2Hz..15Hz` do minimum zmniejsza prąd.

Błąd pozostaje aktywny do zapisu `Fault:Clear`.
Zmiana `Drive:Mode` podczas błędu nie uruchamia napędu.

Napięcie z tabeli wpływa na prąd i szynę DC.
Za wysokie napięcie zwiększa prąd wzbudzenia i obniża napięcie szyny.
Za niskie napięcie może zerwać synchronizm, a energia wirnika podnosi wtedy napięcie szyny.

| `Volt:50Hz` | Prąd szczytowy | Szyna DC | Wynik |
| --- | --- | --- | --- |
| `18V` | `11.1A` | `750V` | `Freeze:State = hv+`, potem `hv+` |
| `33.4V` | `0.6A` | `589V` | praca do błędu `imax` wywołanego kołysaniem |
| `60V` | `14.4A` | `585V` | błąd `imax` |
| `90V` | `29.1A` | `560V` | błąd `irms` |

`irms` wykrywa długie przewzbudzenie z wysokim prądem RMS.
`imax` wykrywa rosnące kołysanie z wysoką wartością szczytową.

Otwarta pętla V/f jest niestabilna w części pasma.
Przy domyślnej tabeli `20Hz`, `90Hz` i `140Hz` są stabilne z rozrzutem kąta `1-2°`.
Postój przy `30Hz` kończy się błędem `imax` po około minucie, a przy `50Hz` po kilku minutach.
Przejazd rampą przez to pasmo jest stabilny w obu kierunkach.
Strefy `Resonance:*` służą do omijania takich częstotliwości.

`Ctrl:Mode = off` podczas pracy działa jak zadanie `0`.
`RENDER_Disable` zeruje setpoint, a napęd zatrzymuje się według tabeli `Fall`.
Tylko błąd natychmiast wyłącza mostek.

Domyślny wentylator nie oddaje energii do szyny.
Jego moment rośnie z kwadratem prędkości, dlatego hamuje wał szybciej niż rampa `Fall`.
Do testowania `Brake:RegenBand`, `Freeze:VdcHigh` i `hv+` służy obciążenie bezwładnościowe.

## Strojenie modelu

- `machine.DEAD_COMP` przesuwa punkt najmniejszego prądu w tabeli `Volt`.
  Zmień go, gdy prąd modelu nie odpowiada tabeli `Curr` przy tej samej częstotliwości.
- `observer.ERR_GAIN` określa wpływ błędu `Obs:DtComp` na `Obs:AngleErr` i `Obs:Bias`.
  Nie wpływa na bramkę przejęcia, ponieważ dyskryminator PLL usuwa stały błąd.
  Błąd `Obs:DtComp` diagnozuje się przez `Obs:Bias`.
- `observer.RIPPLE_deg` określa głębokość minimum tętnienia używanego przy przejęciu.
- `machine.DAMP_GAIN_s` określa przechył ramki dla `If:Damp = 100%` przed ograniczeniem do ±8°.
- `machine.ROTOR_DAMP_Nms` opisuje prądy wirowe w magnesach i tulei.
  Charakterystyka maleje powyżej `ROTOR_SLIP_rads`, więc zatrzymany wirnik nie zachowuje się jak silnik klatkowy.
- `machine.BUS_RSRC_ohm` opisuje impedancję sieci za prostownikiem.
  Przy mocy znamionowej szyna spada do około `568V`, czyli około `20V` powyżej `Freeze:VdcLow = 550`.
- `machine.LINK_DRAIN_W` opisuje zasilacz flyback i upust szyny.
  Jest to droga rozładowania szyny po wyłączeniu mostka.

## Dokumentacja firmware

Powiązana dokumentacja znajduje się w repozytorium `ectra`:

- mapa rejestrów i skale: `foc-ifc/.docs/regs.md`
- tryby, start i zatrzymanie: `foc-sig/.docs/drive.md`
- obserwator i warunek przejęcia: `foc-sig/.docs/foc.md`
- progi i drabinka błędów: `foc-sig/.docs/protect.md`
- model C i scenariusze wzorcowe: `foc-tests/plant/` i `foc-tests/cases/`

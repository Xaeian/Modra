# Model napędu `ectra`

Pakiet `ectra` jest fizycznym modelem napędu używanym przez port `SIM`.
W przeciwieństwie do ogólnego symulatora z `sim.py` nie generuje każdego rejestru osobno: wszystkie odczyty wynikają z jednego stanu maszyny, dlatego zmiana nastawy wpływa na cały punkt pracy.

Ta sama wersja pakietu jest używana w repozytorium stanowiska, w katalogu `ectra/bench`.
Obie kopie, razem z `regs.csv`, trzeba aktualizować równocześnie i w całości.

## Uruchomienie

W Modrze symulator włącza wpis w `app.ini`:

```ini
sim = ectra
```

Pakiet rejestruje się podczas importu.
`Binding.match` rozpoznaje mapę rejestrów Ectry; jeżeli mapa nie pasuje, port `SIM` korzysta z ogólnego symulatora.

`EctraClient` przyjmuje opcjonalny parametr `speed`, który określa liczbę sekund modelu przypadającą na sekundę czasu rzeczywistego.
Wartość domyślna to `1`; na stanowisku można na przykład użyć `speed=10`.

Scenariusz bez aplikacji działa tak szybko, jak pozwala procesor:

```powershell
py -m ectra [vf|if|foc] [Hz] [s]
```

Polecenie wypisuje zmiany etapu, przejęcia FOC, powroty do I/f oraz bilans końcowy.

## Warstwy

Zależności między modułami są acykliczne. Każdy plik ma jedno zadanie:

- `curve.py`: interpolacja i ograniczanie wartości
- `command.py`: komenda jednego kroku w jednostkach fizycznych
- `machine.py`: uzwojenie w układzie d/q, mostek, wał, obciążenie wentylatorowe, szyna DC i model cieplny
- `ramp.py`: limity częstotliwości, redukcja prędkości, zamrożenie rampy i podtrzymanie punktu pracy
- `observer.py`: obserwator strumienia z pętlą PLL, odwzorowujący `obs.c`
- `detector.py`: bramka przejęcia, warunki powrotu do I/f, resynchronizacja i `Foc:RetryHold`
- `protect.py`: zabezpieczenia programowe i komparator sprzętowy
- `plant.py`: kolejność obliczeń i zmiany etapów pracy
- `meter.py`: szybka (`ctrl`) i wolna (`view`) warstwa pomiarowa
- `scope.py`: publikacja szybkich sygnałów w wolno odczytywanych rejestrach, zgodnie z `scope.c`
- `runner.py`: wątek maszyny z własnym zegarem i skalą `speed`
- `names.py` i `binding.py`: nazwy rejestrów, konwersja między rejestrami a modelem oraz omijanie pasm rezonansu
- `client.py`: klient zgodny z interfejsem `SimulatedClient`
- `__main__.py`: scenariusz uruchamiany z terminala

Pakiet zależy od interfejsu udostępnionego przez `sim.py`; ogólny kod Modbusa nie zawiera zależności od Ectry.

## Krok symulacji

Wątek w `runner.py` budzi się co około `10 ms` czasu rzeczywistego, niezależnie od częstotliwości odpytywania rejestrów; upływ czasu modelu uwzględnia skalę `speed`.
`Plant` dzieli każdy krok na podkroki o docelowej długości `0,5 ms`.
Uzwojenie jest całkowane z dokładnym obrotem układu współrzędnych, a odpowiedź pętli prądowej wynika z `Foc:CurrBw`.
Napięcie potrzebne do uzyskania zadanej zmiany prądu wynika z modelu uzwojenia i jest następnie ograniczane przez dostępne napięcie szyny.

Obserwator otrzymuje te same sygnały co firmware: napięcie odtworzone ze sterowania mostkiem i zmierzony prąd.
Nie zna rzeczywistej straty mostka; uwzględnia jedynie kompensację ustawioną w `Obs:DtComp`.

Parametry rzeczywistej maszyny są niezależne od nastaw `Motor:*`.
Domyślnie model używa między innymi `KE_V_Hz = 0.55`, krzywej obciążenia `LOAD_CURVE`, bezwładności `INERTIA_kgm2` oraz zależnej od prądu straty mostka `LOSS_V`.
Stałe służące do kalibracji modelu znajdują się na początku `machine.py`.

## Odwzorowane zachowania

Model obejmuje:

- etapy `Drive:Stage`, rozruch z wyrównaniem lub przez tabelę `Volt` oraz pracę V/f, I/f i FOC
- bramkę przejęcia FOC, `Foc:EntryGlide`, powroty do I/f, resynchronizację, `Foc:RetryHold` oraz diagnostykę `Sync:ExitCause`, `Sync:ExitTime` i `Foc:TakeoverDelta`
- pętle prądu i prędkości, ograniczenie modulacji oraz ograniczanie momentu regeneracyjnego
- zabezpieczenia `peak`, `irms`, `imax`, `temp`, `hv-`, `hv+`, `stall`, `spin` i `sync`
- dwa poziomy filtrowania pomiarów oraz obwiednie i średnie publikowane przez `scope.py`

Kalibracja z 3 września 2026 r. obejmuje pracę do `80 Hz`: prądy wynikające z tabeli, moc pozorną w kolejnych punktach, współczynnik modulacji, przebieg rampy, bramkę prędkości oraz przyczyny powrotu z FOC do I/f.
Zabezpieczenie `spin` używa tego samego wskaźnika mocy co `protect.c`.
Podczas pracy z wymuszonym kątem jest aktywne, gdy `Curr:40Hz` nie jest mniejsze niż `Curr:15Hz`; po przekroczeniu `40 Hz` zgłasza błąd, jeżeli moc nie wzrośnie o wartość wymaganą dla danego wariantu napędu.

## Znane ograniczenia

Model nie odtwarza jeszcze obserwowanego wzrostu `Sync:ErrPeak` wraz z prądem ani utraty synchronizacji około `50 ms` po przejęciu.
W obecnej symulacji pętla pozostaje stabilna przy kącie obciążenia rzędu `50–60°`.
Te rozbieżności wymagają dalszej walidacji na stanowisku i nie powinny być traktowane jako potwierdzenie marginesu stabilności rzeczywistego napędu.

## Dokumentacja firmware

Poniższe ścieżki znajdują się w repozytorium firmware `ectra`, a nie w tym repozytorium:

- mapa rejestrów i skale: `foc-ifc/.docs/regs.md`
- obserwator i przejęcie: `foc-sig/.docs/foc.md`, `foc-sig/ctrl/obs.c`
- progi i błędy: `foc-sig/.docs/protect.md`

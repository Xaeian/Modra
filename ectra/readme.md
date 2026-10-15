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

`EctraClient` przyjmuje opcjonalny parametr `speed`, który określa liczbę sekund modelu przypadającą na sekundę czasu rzeczywistego; wartość domyślna to `1`.
Z `lockstep=True` model nie ma własnego zegara: rusza się tylko w `Runner.advance`, krokami po `10ms`, tak szybko, jak liczy procesor, i daje ten sam wynik niezależnie od prędkości. Tak jeździ port `SIM` ławki: jej `sleep` posuwa model, a `now` czyta jego czas.

Scenariusz bez aplikacji działa tak szybko, jak pozwala procesor:

```powershell
py -m ectra [vf|if|foc] [Hz] [s]
```

Polecenie wypisuje każdą zmianę etapu, stanu, zamrożenia rampy, błędu i przejęcia FOC, a na końcu bilans.

## Warstwy

Zależności między modułami są acykliczne. Każdy plik ma jedno zadanie:

- `curve.py`: interpolacja i ograniczanie wartości
- `command.py`: komenda jednego kroku w jednostkach fizycznych
- `machine.py`: uzwojenie w układzie d/q, mostek, wał, obciążenie wentylatorowe, szyna DC i model cieplny
- `ramp.py`: limity częstotliwości, redukcja prędkości, zamrożenie rampy i podtrzymanie punktu pracy
- `observer.py`: obserwator strumienia z pętlą PLL, taki jak w napędzie
- `detector.py`: bramka przejęcia i detektory utraty zamkniętej pętli (fault `sync`)
- `protect.py`: zabezpieczenia programowe i komparator sprzętowy
- `plant.py`: kolejność obliczeń i zmiany etapów pracy
- `meter.py`: szybka (`ctrl`) i wolna (`view`) warstwa pomiarowa
- `scope.py`: publikacja szybkich sygnałów w wolno odczytywanych rejestrach, jak w napędzie
- `runner.py`: wątek maszyny z własnym zegarem i skalą czasu albo krok na żądanie w `lockstep`
- `names.py` i `binding.py`: nazwy rejestrów, konwersja między rejestrami a modelem oraz omijanie pasm rezonansu
- `client.py`: klient zgodny z interfejsem `SimulatedClient`
- `__main__.py`: scenariusz uruchamiany z terminala

Pakiet zależy od interfejsu udostępnionego przez `sim.py`; ogólny kod Modbusa nie zawiera zależności od Ectry.

## Krok symulacji

Wątek w `runner.py` budzi się co około `10ms` czasu rzeczywistego, niezależnie od częstotliwości odpytywania rejestrów, a upływ czasu modelu uwzględnia skalę `speed`.
W `lockstep` wątku nie ma, a krok ma zawsze `10ms`: detektor przejęcia ma taki sam takt i musi zobaczyć każde okno.
`Plant` dzieli każdy krok na podkroki o docelowej długości `0.5ms`.
Uzwojenie jest całkowane z dokładnym obrotem układu współrzędnych, a odpowiedź pętli prądowej wynika z `Foc:CurrBw`.
Napięcie potrzebne do uzyskania zadanej zmiany prądu wynika z modelu uzwojenia i jest następnie ograniczane przez dostępne napięcie szyny.

Obserwator otrzymuje te same sygnały co firmware: napięcie odtworzone ze sterowania mostkiem i zmierzony prąd.
Nie zna rzeczywistej straty mostka; uwzględnia jedynie kompensację ustawioną w `Obs:DtComp`.
`If:Damp` działa jak w napędzie: z napięcia osi q, przez ten sam łańcuch filtrów, bez dostępu do rzeczywistego kąta wirnika.
Wektor wymuszony przechodzi przez referencje ze slew jak w firmware: przy catch przejmuje zmierzony prąd, przy przejęciu obraca się razem z ramką, a moment startuje od rzutu na oś q.

Parametry rzeczywistej maszyny są niezależne od nastaw `Motor:*`.
Domyślnie model używa między innymi `KE_V_Hz = 0.55`, krzywej obciążenia `LOAD_CURVE`, bezwładności `INERTIA_kgm2` oraz zależnej od prądu straty mostka `LOSS_V`.
Stałe służące do kalibracji modelu znajdują się na początku `machine.py`.

## Odwzorowane zachowania

Model obejmuje:

- etapy `Drive:Stage`, rozruch z wyrównaniem lub przez tabelę `Volt` oraz pracę V/f, I/f i FOC
- bramkę przejęcia FOC, utratę zamkniętej pętli jako fault `sync` oraz diagnostykę `Sync:ExitCause`, `Sync:ExitTime` i `Foc:TakeoverDelta`
- pętle prądu i prędkości (regulator bez momentu hamującego) oraz ograniczenie modulacji
- wstrzymanie rampy (`hold`) na suficie napięcia w I/f i w pętli zamkniętej, z tym samym licznikiem nasycenia 200ms co napęd
- zabezpieczenia `peak`, `irms`, `imax`, `temp`, `hv-`, `hv+`, `stall`, `spin` i `sync`
- dwa poziomy filtrowania pomiarów oraz obwiednie i średnie publikowane przez `scope.py`

Kalibracja z 3 września 2026 r. obejmuje pracę I/f do `80Hz`: prądy wynikające z tabeli, moc pozorną w kolejnych punktach, współczynnik modulacji, przebieg rampy i bramkę prędkości.
Obciążenie wentylatora `LOAD_CURVE` pochodzi z zamkniętej pętli z 25 i 27 września: prąd momentu `Foc:IqCmd` na schodkach `40–105Hz` zgadza się z modelem co do `0.04A`.
`py check_model.py` zestawia model z pomiarami z 3, 23, 25 i 27 września; liczby do porównania są w opisie każdego scenariusza.
Zabezpieczenie `spin` używa tego samego wskaźnika mocy co napęd.
Podczas pracy z wymuszonym kątem jest aktywne, gdy `Curr:40Hz` nie jest mniejsze niż `Curr:15Hz`; po przekroczeniu `40Hz` zgłasza błąd, jeżeli moc nie wzrośnie o wartość wymaganą dla danego wariantu napędu.

## Znane ograniczenia

Przy nastawach z 23 września obserwator w modelu jest dziesięć razy czystszy niż na stanowisku: `Sync:Err` około `1°` i `Sync:ErrPeak` około `3°` wobec `12°` i `30°`.
Strumień ISR pokazuje w kącie i w `w_hat` prążek o częstotliwości elektrycznej, ale jego amplituda zmienia się między przebiegami przy tych samych nastawach od `3°` do `9°` i nie zależy od `Obs:HpHz` tak, jak zależałoby stałe przesunięcie napięcia mostka; jego przyczyna nie jest znana i model go nie zawiera.
Brakuje też wolnego pływania kąta: odchylenie standardowe kąta w strumieniu ISR wynosiło `14–17°`.
`Obs:AngleErr` w I/f to na stanowisku głównie błąd obserwatora: przy `45Hz` i `1.55A` kąt obciążenia wynosi około `19°`, a rejestr pokazuje od `−51°` do `−76°`.
Model ma prawdziwy kąt obciążenia i prawie żadnego błędu obserwatora, więc pokazuje od `−35°` przy `45Hz` do `−28°` przy `55Hz`.
Model nie zna też drugiego stanu I/f, w którym napęd przy tych samych nastawach pracował z modulacją `9%` i kątem około `−120°`.
Najważniejsza rozbieżność: w modelu zamknięta pętla trzyma, a na stanowisku każde przejęcie z 23 września kończyło się `slip` po `30ms` do `4s`.
Mechanizm tego rozpadu jest nieznany, więc model nie może być traktowany jako potwierdzenie marginesu stabilności rzeczywistego napędu.

Model nie ma tętnienia prądu: pętle odtwarzają zadany prąd, a `NOISE_A` wynosi zero.
Na stanowisku 1.5kW przy `190Hz` szczyty prądu sięgały `7.0A`, tuż pod progiem wyłączenia, a napięcie w pojedynczych okresach dochodziło do sufitu.
Model pokazuje tam gładki prąd, więc nie odtworzy błędów `peak` ani chwilowego `sat` z góry zakresu.

Strata mostka `LOSS_V` odpowiada postojowi, a nie zamkniętej pętli.
W closed napięcie pętli na stanowisku to prawie sama siła elektromotoryczna (`35.7V` przy `60Hz`, `65.5V` przy `105Hz`), a w modelu jest o `11–12V` wyższe.
Przy małym prądzie w closed obserwator modelu jest też wrażliwszy na `Obs:DtComp` niż napęd: zjazd do `40Hz` przy `0.47A` gubi pętlę przy `100%` i `78%`, a trzyma dopiero przy `60%`; napęd trzymał `40Hz` przy `100%`.
Bezwładność wentylatora zmierzona na rampach regulatora prędkości to `0.24kg·m²`, a model liczy `0.05`.
Przy stracie mostka z modelu start V/f daje `1.3A` przy `2.4Hz` zamiast zmierzonych `3.35A` i nie wciąga cięższego wirnika w synchronizm, a napęd go wciąga.
Z tą samą stratą praca V/f w modelu kończy się faultem `stall` przy około `31Hz`, poniżej okna silnika 1.5kW.
Rampy w closed dokładają więc w modelu `0.05–0.1A` zamiast `0.3A`, a wybieg z `45Hz` trwa około `4s` zamiast około `20s`.

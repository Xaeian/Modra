# Model napędu `ectra`

Pakiet `ectra` jest fizycznym modelem napędu używanym przez port `SIM`.
W przeciwieństwie do ogólnego symulatora z `sim.py` nie generuje każdego rejestru osobno: wszystkie odczyty wynikają z jednego stanu maszyny, dlatego zmiana nastawy wpływa na cały punkt pracy.

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
Pętle niosą prąd z gładkim obrotem swojego układu, rampą w I/f i prędkością PLL w closed, jak integratory napędu, a resztę ruchu układu, pochylenie `If:Damp` i poprawki PLL, gonią swoim pasmem.
Prąd niesiony z wirnikiem dawał odtłumianie: wirnik wychylony naprzód ciągnął swój prąd naprzód, a kołysanie I/f 4kW przy `15Hz` rosło samo z ±60° do ±90° w 45s.
Napięcie potrzebne do uzyskania zadanej zmiany prądu wynika z modelu uzwojenia i jest następnie ograniczane przez dostępne napięcie szyny.

Obserwator otrzymuje te same sygnały co firmware: napięcie odtworzone ze sterowania mostkiem i zmierzony prąd.
Nie zna rzeczywistej straty mostka; uwzględnia jedynie kompensację ustawioną w `Obs:DtComp`.
`If:Damp` działa jak w napędzie: z napięcia osi q, przez ten sam łańcuch filtrów, bez dostępu do rzeczywistego kąta wirnika.
Wektor wymuszony przechodzi przez referencje ze slew jak w firmware: przy catch przejmuje zmierzony prąd, przy przejęciu obraca się razem z ramką, a moment startuje od rzutu na oś q.

Parametry rzeczywistej maszyny są niezależne od nastaw `Motor:*`.
Stałe kalibracji są na początku `machine.py`, każda z opisem pomiaru, z którego pochodzi.
Obie maszyny są z przebiegów 10–12.11 na 0.13.4, pierwszym wydaniu, które dokładnie czyta napięcie wektora:

| Stała | 1.5kW, wirnik 400 | 4kW, sztuka 99 | Skąd |
| --- | --- | --- | --- |
| SEM | `0.42V` na Hz | `0.83V` na Hz | 1.5kW strumień obserwatora przy 70–195Hz, 4kW karta zgodna z napięciem w closed |
| Rezystancja | `1.58Ω` | `0.44Ω` | 1.5kW nachylenie prądu align względem `Volt:0Hz`, 4kW razem ze stratą, uzwojenie ze spadkiem mostka |
| Strata mostka | `10.0V` | `9.0V` | 1.5kW ruszenie V/f do catch, 4kW align, ruszenie i kąt I/f startów 12.11 na tabeli stanowiska |
| Bezwładność | `0.12kg·m²` | `0.25kg·m²` | `Foc:IqCmd` na podjazdach w closed ponad opór z prawa kwadratu, 218 i 242 podjazdów |
| Opór cieplny stopnia mocy | `1.0°C/W` | `0.6°C/W` | `MeasCtrl:Temp` przy prądzie trzymanym w closed |
| Obciążenie | `0.074Nm + 1.07·10⁻⁴·ω²` | `0.34Nm + 1.82·10⁻⁴·ω²` od 70Hz, `1.06–1.20Nm` przy 45–55Hz | `Foc:IqCmd` na schodkach w closed |

Strata 1.5kW jest cała od `0.1A`, bo w closed przy `30Hz` i `0.16A` napęd potrzebował SEM i prawie całej straty.
Strata 4kW zanika pod `0.8A`, w tętnieniu PWM jego uzwojenia: w closed odczyt dawał 5V przy 0.45A i 10V od 2A.
Para 4kW trafia naraz w align, w ruszenie do catch i w kąt obserwatora w I/f.
Poprzednia, `0.62Ω` i `7.65V`, pochodziła z trzech odczytów align jednej próby i zostawiała kąt I/f o 10° bliżej pola niż na stanowisku, więc start był oceniany jako przy polu.
Bezwładność 4kW `0.18kg·m²` wychodziła z oporu liczonego prostą między postojami, który w połowie długiego podjazdu jest za wysoki.
Czujnik `MeasCtrl:Temp` siedzi na stopniu mocy, więc grzeje go strata mostka, a nie miedź uzwojenia: na stanowisku temperatura rosła z prądem, nie z jego kwadratem.
Pętla prędkości na `Foc:IqMax` wstrzymuje rampę (`lim`), a całka liczy dalej, jak w napędzie, więc 1.5kW staje przy 198Hz.
Mapa wpisuje 1.5kW `Motor:Ke` 103.8, czyli √2 więcej niż SEM silnika stanowiska; model to zachowuje, jak napęd.
Pomiar fazy (`MeasCtrl:CurrU/V/W`) to RMS fazy w oknie, tak jak w napędzie: na postoju prąd stały fazy, w ruchu RMS wektora, a `irms` i `stall` czytają średnią trzech faz.

`py check_model.py` zestawia model z napędem: align, ruszenie V/f, napięcie I/f i punkty closed obu silników.

| Wielkość | 1.5kW: model wobec napędu | 4kW: model wobec napędu |
| --- | --- | --- |
| prąd align | 13–18% niżej | 4–5% niżej |
| ruszenie V/f, średnia faz | do 5% | do 6%, przy 1Hz 12% wyżej |
| napięcie I/f | 0.3–1.4V wyżej | od −0.1 do +1.1V przy 7–40Hz |
| napięcie closed | od +3.3 do −5.4V przy 45–195Hz | od −0.6 do +2.7V przy 50–190Hz |
| `Foc:IqCmd` w closed | do 1% od 60Hz | do 1% |

Odniesienie 4kW to 20 startów 12.11 na własnej tabeli stanowiska, `Volt` 17.4, 17.4, 16.7 i 18.6V, align 700ms i catch 6.25Hz.
SIM `start` 4kW na tych stałych: w mocy 3/3 i 8/8 czysty, najwyższy kąt po catch −4° wobec −5.3° stanowiska, kołysanie 5.1° wobec 3.6°, szyna bez wzrostu.

## Wariant 4kW

`SIM 4kW` sieje rejestry kolumną 4000W mapy i jedzie maszyną 4kW z `IRON` w `machine.py`, a sam `SIM` to nadal 1.5kW.
Komparator `25.8A` amplitudy jest ze schematu płytki: `peak` przy 0.8Hz przychodził z prądem osi d 17–25A, ponad prądem postoju 18A.
Szyna ma `60µF`.
Przy przejęciu prądu obserwator rusza od kąta pola, z prędkością rampy, tak jak w napędzie, więc przez pierwsze ułamki sekundy kąt do pola jest bliski zera.

## Odwzorowane zachowania

Model obejmuje:

- etapy `Drive:Stage`, rozruch z wyrównaniem lub przez tabelę `Volt` oraz pracę V/f, I/f i FOC
- bramkę przejęcia FOC, utratę zamkniętej pętli jako fault `sync` oraz diagnostykę `Sync:ExitCause`, `Sync:ExitTime` i `Foc:TakeoverDelta`
- pętle prądu i prędkości (regulator bez momentu hamującego) oraz ograniczenie modulacji
- wstrzymanie rampy (`hold`) na suficie napięcia w I/f i w pętli zamkniętej, z tym samym licznikiem nasycenia 200ms co napęd
- zabezpieczenia `peak`, `irms`, `imax`, `temp`, `hv-`, `hv+`, `stall`, `spin` i `sync`
- dwa poziomy filtrowania pomiarów oraz obwiednie i średnie publikowane przez `scope.py`

Zabezpieczenie `spin` używa tego samego wskaźnika mocy co napęd.
Podczas pracy z wymuszonym kątem jest aktywne, gdy `Curr:40Hz` nie jest mniejsze niż `Curr:15Hz`; po przekroczeniu `40Hz` zgłasza błąd, jeżeli moc nie wzrośnie o wartość wymaganą dla danego wariantu napędu.

## Znane ograniczenia

Obserwator porównuje strumień z końca kroku z kątem PLL z jego początku, jak napęd.
Krok napędu to okres PWM, 0.1ms, a podkrok modelu 0.5ms, więc bez poprawki model wyprzedzał wirnik pięć razy bardziej: 17° przy 195Hz zamiast 3.7°, z `id` około −1.1A i napięciem closed o 15V niższym niż na napędzie.
Kąt, z którym model porównuje strumień, idzie więc naprzód o różnicę połówek obu kroków, a reszta wyprzedzenia jest taka jak w napędzie: 1.4° przy 50Hz i 6.2° przy 195Hz wobec 1.0° i 3.7° modelu na kroku 0.1ms.

Strata mostka modelu to fala prostokątna wzdłuż znaku prądu każdej fazy.
1.5kW trafia w ruszenie, bo to je czyta `stall`, a align czyta 13–18% za nisko.
Kąt obserwatora w I/f 1.5kW stoi przy 12–18Hz o 8° bliżej pola niż w zapisie stanowiska z 10.11, a amplituda i okres kołysania po catch, ±25° co 0.75s, się zgadzają.
To ten sam ślad co w 4kW, strata, której obserwator nie kompensuje; nachylenie align 1.5kW z trzech odczytów trzyma jednak rezystancję, więc para nie jest przestawiona.

Dojście 4kW po zatrzymaniu rampy czyta −12.5° wobec −9.7° na stanowisku: obciążenie przy 45–55Hz jest z pomiaru w closed, a kąt zawiera jeszcze błąd obserwatora.
Pod 45Hz obciążenia 4kW nikt nie zmierzył: krzywa łączy tam tylko 0.45Nm przy 25rad/s z pomiarem przy 47rad/s, bez podstawy fizycznej.
Kąty I/f stanowiska dawałyby moment malejący z obrotami, który w modelu rozkołysał I/f, więc go nie ma.
Po catch 4kW kołysze w modelu mocniej niż na stanowisku: wygładzony kąt od −4 do −24° wobec −6 do −17°; mechanizmu tłumienia, którego brakuje, dane nie pokazują.
Start z align wektorem i I/f od około 1Hz model ocenia czysto, a jedyny taki start 4kW na stanowisku pompował szynę o 149V i skończył `peak`.

W zawieszeniu I/f 1.5kW przy 40Hz stanowisko trzyma kołysanie ±48° co 0.8s i pompuje szynę do 736V przy każdym wahnięciu.
Model zaczyna od tej samej amplitudy, ale kołysanie gaśnie, a szyna nie rośnie nawet przy pojemności `60µF`: strata mostka zjada oddaną energię.

Zjazd w closed pod punkt przejęcia przy małym prądzie gubi w modelu pętlę 1.5kW przy 35Hz i 4kW przy 25Hz, a stanowisko 1.5kW przejeżdżało 30Hz.
Przejęcie 1.5kW przy 40Hz z `SpeedCtrl:Kp` 225 gubi w modelu pętlę po 2–6s, a stanowisko 11.11 trzymało ją na tej nastawie.

Obserwator modelu jest czystszy niż na stanowisku: nie ma prążka 1× w kącie i w `w_hat`, który na stanowisku zmieniał się między przebiegami od 3° do 9°, ani wolnego pływania kąta.
Nie ma też drugiego stanu I/f, w którym napęd przy tych samych nastawach pracował z modulacją 9% i kątem około −120°.
Model nie może więc potwierdzać marginesu stabilności zamkniętej pętli.

Model nie ma tętnienia prądu: pętle odtwarzają zadany prąd, a `NOISE_A` wynosi zero.
Na stanowisku 1.5kW przy `190Hz` szczyty prądu sięgały `7.0A`, tuż pod progiem wyłączenia, a napięcie w pojedynczych okresach dochodziło do sufitu.
Model pokazuje tam gładki prąd, więc nie odtworzy błędów `peak` ani chwilowego `sat` z góry zakresu.

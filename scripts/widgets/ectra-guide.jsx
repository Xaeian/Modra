// scripts/widgets/ectra-guide.jsx

// The tuning book: what to do at each stage of bringing up a PMSM drive, and in what order.
// Prose only, because every knob it could offer is a knob the grid already has:
// one control in two places is one control too many.
//
// What it does instead is aim the rest of the app.
// Picking a stage highlights the registers that stage tunes,
// charts what has to be watched while tuning them,
// and drops the groups that take no part in it out of the poll cycle.
// That is the part modra cannot do on its own:
// it holds no opinion about any device, and this file is nothing but an opinion about one.
//
// Tables live in `ectra-tables.jsx`.
// A table is a shape the grid cannot draw, so it earns its own panel;
// this one earns a column beside the grid,
// because its text and the rows it points at have to be readable together.

const EC_STAGE_KEY = "modra.ectra.stage";

// Groups no page of this book ever tunes:
// a log, counters, the identity of the board, the serial port, the flow table.
// Still readable and writable, they simply stop costing a slot in every cycle,
// so what IS being tuned comes back faster.
//
// `Flow` and `Journal` alone are 367 of 640 registers,
// and every remaining group is between five and twenty-four.
// That is the whole argument for where this list ends:
// past these, muting buys almost nothing and risks hiding a reading that turns out to matter.
// Filter calibration (`MeasCfg`, `Trim`) stays in view for exactly that reason:
// a wrong current scale is the first stage's problem and it would be invisible from here.
const EC_DEAD = [
  "Flow:*", "Journal:*", "Counter:*", "Version:*", "System:*",
  "RS485:*", "Digital:*", "AnalogInput:*", "Failsafe:*",
];

// Skip bands shape a voltage table and nothing else, so only the V/f page keeps them.
// Every page carries its own list, built from the shared floor.
const EC_MUTE_VF = EC_DEAD;
const EC_MUTE = EC_DEAD.concat("Resonance:*");

// Every register a page names in its own prose.
// The page talks about it, so the page has to keep it arriving:
// an instruction pointing at a row frozen at its last value is worse than no instruction.
// Derived from the text rather than listed beside it,
// because a list beside it is a list that goes stale.
const ecNamed = (text) => text.match(/[A-Z][A-Za-z]*:[A-Za-z0-9]+/g) || [];

// Lit in the grid at every stage.
// How the drive is commanded, what it made of that, and how a fault is cleared
// belong to no single step: they are how you start, stop and recover at each of them,
// and a stage that hid them would be a stage you cannot leave.
//
// `Drive:Stage` earns its place twice over.
// `Drive:Mode` is what you asked for and `Drive:Stage` is what the drive did with it,
// and the two disagree exactly when something is wrong:
// missing motor constants drop a vector run to `obs`, a bad current channel to `guard`.
// Reading the request without the answer
// is how an hour goes into tuning a mode that never engaged.
const EC_FIND_ALWAYS =
  "Ctrl:Mode|Ctrl:Setpoint|Drive:Mode|Drive:Stage|Fault:Code|Fault:Clear";

// Charted at every stage: what the drive was asked for, what it rendered,
// what came back from the meters, and the two readings that end a run badly.
const EC_ALWAYS = [
  "Feedback:SetpointFreq", "Feedback:RenderFreq", "MeasCtrl:Freq",
  "MeasCtrl:CurrAvg", "MeasCtrl:PeakMax", "MeasCtrl:Temp",
  // Charted as well as lit, because the counters beside it say
  // how many takeovers and fallbacks there were and never when.
  // A stepped trace of the stage is the only place a drop out of `closed` has a time on it.
  "Drive:Stage",
];

// Panels are small unless a reading earns otherwise.
// The operating point always does:
// it is the one trace that says whether the drive is doing what was asked.
// Each stage adds the single reading it is tuning against.
const EC_BIG = ["Feedback:RenderFreq"];

// `\n` starts a paragraph.
// `find` is a strict search query, `|` joining alternatives,
// so a stage leaves exactly its own registers lit in the grid.
// `table` is the one the tables panel is asked to open, where the stage works on one.
const EC_INTRO =
  "Ten panel prowadzi krok po kroku przez uruchomienie i strojenie napędu PMSM. "
  + "Wybierz etap, a Modra pokaże potrzebne rejestry i wykresy. Kliknij aktywny etap "
  + "ponownie, aby wrócić do własnego widoku."
  + "\n"
  + "Ctrl:Mode wybiera źródło i jednostkę wartości zadanej: ai to wejście analogowe, "
  + "% to procent zakresu, rpm to obroty na minutę, a Hz to częstotliwość. Wartość "
  + "off zatrzymuje napęd. Ctrl:Setpoint podaje wartość w wybranej jednostce. Odczytuj "
  + "oba rejestry łącznie."
  + "\n"
  + "Drive:Mode wybiera żądany tryb sterowania: vf to sterowanie skalarne według tabeli "
  + "Volt, if to sterowanie prądowe z wymuszonym kątem, a foc po synchronizacji "
  + "zamyka pętlę wektorową. Drive:Stage pokazuje tryb rzeczywiście używany przez "
  + "napęd. Jeżeli sterowanie wektorowe się nie uruchomi, Drive:Stage wskazuje etap, "
  + "na którym procedura się zatrzymała."
  + "\n"
  + "Nazwy rejestrów w tekście są klikalne. Najedź kursorem, aby wskazać wiersz w "
  + "siatce, albo kliknij, aby do niego przejść.";

const EC_STAGES = [

  { id: "dane", label: "1 Dane",
    find: "Motor:|Sense:PhaseMap|Sense:Shunt",
    mute: EC_MUTE,
    plot: ["Foc:GuardId", "Foc:GuardIdRef"], big: [],
    text:
      "Cel: wpisać dane silnika i sprawdzić tor pomiaru prądu. Bez Motor:Rs sterowanie "
      + "wektorowe się nie włączy. Bez Motor:Ke napęd może pracować w trybie I/f, ale "
      + "FOC nie przejmie sterowania."
      + "\n"
      + "Motor:Rs zmierz między fazami na zaciskach falownika, uwzględniając kabel, i "
      + "wpisz połowę wyniku. Motor:Lq zmierz analogicznie miernikiem LCR w paśmie od "
      + "100Hz do 1kHz: obróć wał, znajdź największy odczyt, a wynik również podziel "
      + "przez dwa. "
      + "Motor:PolePairs to liczba par biegunów, nie liczba biegunów. Motor:Ke podaj "
      + "jako międzyfazowe napięcie RMS przy 1000rpm, na podstawie danych znamionowych "
      + "silnika lub pomiaru wybiegu przy odłączonym mostku."
      + "\n"
      + "Motor:Invert zmienia kierunek obrotów. Sense:PhaseMap opisuje znaki i kolejność "
      + "kanałów prądowych na płytce. To dwa niezależne ustawienia: zamiana przewodów "
      + "silnika nie zmienia torów pomiarowych falownika."
      + "\n"
      + "Jeżeli Drive:Stage pokazuje guard, porównaj Foc:GuardId z Foc:GuardIdRef. Gdy "
      + "wartość zadana jest niezerowa, a Foc:GuardId pozostaje bliski zera, sprawdź "
      + "okablowanie i ciągłość kanału pomiarowego. Przeciwny znak wskazuje odwróconą "
      + "polaryzację. Duża różnica przy zgodnym znaku wskazuje na błędne ustawienie "
      + "Sense:PhaseMap. Zmieniaj tylko jedno ustawienie lub połączenie naraz. Po każdej "
      + "zmianie wykonaj krótki rozruch."
      + "\n"
      + "Na końcu sprawdź Sense:ShuntRes i Sense:ShuntGain. Błędna skala nie musi "
      + "wywołać błędu, ale zafałszuje dobór tabeli Curr i limitów prądu oraz wszystkie "
      + "późniejsze pomiary."
      + "\n"
      + "Zakończ etap dopiero, gdy MeasCtrl:CurrAvg zgadza się z zewnętrznym pomiarem "
      + "prądu w przewodzie fazowym." },

  { id: "vf", label: "2 V/f",
    table: "Volt",
    find: "Volt:|MeasCtrl:CurrAvg|Drive:InitFreq",
    mute: EC_MUTE_VF,
    plot: ["Feedback:Volt", "Feedback:ModIndex"], big: ["MeasCtrl:CurrAvg"],
    text:
      "Cel: dobrać tabelę Volt. Ustaw Drive:Mode = vf. W tym trybie "
      + "napięcie silnika wynika bezpośrednio z tabeli i nie jest korygowane na "
      + "podstawie sprzężenia zwrotnego. W trybach if i foc ta sama tabela wyznacza "
      + "napięcie tylko w początkowej fazie rozruchu, gdy If:CatchFreq jest większe "
      + "od zera."
      + "\n"
      + "Dobierz punkty tabeli Volt. Obserwuj MeasCtrl:CurrAvg. Utrzymuj stałą "
      + "prędkość, zmieniaj najbliższy punkt o krok w dół albo w górę i po każdej "
      + "zmianie czekaj, aż odczyt się ustali. "
      + "Wybierz ustawienie zapewniające możliwie niski prąd oraz stabilną, powtarzalną "
      + "pracę silnika. Meas:CurrAvg to wolny odczyt używany do automatycznego "
      + "ograniczania częstotliwości; przy tej regulacji reaguje zbyt późno."
      + "\n"
      + "Zielona linia pokazuje bieżącą częstotliwość, a zielona kropka wskazuje napięcie "
      + "rzeczywiście przyłożone do silnika. Poniżej Volt:2Hz napięcie opada liniowo "
      + "do zera, dlatego ten punkt najsilniej wpływa na obciążony rozruch i końcową "
      + "fazę zatrzymania."
      + "\n"
      + "Sprawdź również rozruch. Rampa rozpoczyna się od Drive:InitFreq, a początkowy "
      + "moment wynika wyłącznie z tabeli Volt, bo nic jeszcze nie reguluje prądu. "
      + "Jeżeli silnik nie rusza, skoryguj Drive:InitFreq i Volt:2Hz. Zbyt niska "
      + "częstotliwość początkowa lub zbyt niskie napięcie powodują zbyt mały moment "
      + "rozruchowy. Zbyt wysokie napięcie zwiększa prąd i może spowodować zadziałanie "
      + "zabezpieczenia stall."
      + "\n"
      + "Zakończ etap, gdy silnik pewnie rusza, a prąd w całym zakresie pracy pozostaje "
      + "niski i powtarzalny." },

  { id: "if", label: "3 I/f",
    table: "Curr",
    find: "If:|Curr:|Foc:IqMax|Drive:AlignTime|MeasCtrl:CurrAvg",
    mute: EC_MUTE,
    plot: ["Foc:IqCmd", "Estim:Freq", "Feedback:Volt", "Obs:AngleErr"], big: ["Foc:IqCmd"],
    text:
      "Cel: sprawdzić sterowanie prądowe przy wymuszonym kącie. Ustaw "
      + "Drive:Mode = if i zacznij od małej częstotliwości bez obciążenia. Tabela Curr "
      + "wyznacza wartość zadaną prądu, a kąt elektryczny nadal wyznacza rampa. "
      + "Prawidłowy stan to Drive:Stage = forced. Obserwator pracuje wtedy w tle, "
      + "ale jeszcze nie steruje silnikiem."
      + "\n"
      + "Foc:IqCmd pokazuje rzeczywistą wartość zadaną prądu. Po osiągnięciu stanu "
      + "ustalonego MeasCtrl:CurrAvg powinien być zbliżony do tej wartości. Duża różnica "
      + "oznacza, że pętla prądowa nie osiąga wartości zadanej. Najpierw sprawdź "
      + "skalę pomiaru prądu i zapas napięcia; nie kompensuj tych problemów zmianami "
      + "w tabeli Curr."
      + "\n"
      + "Rejestry prądowe podają skuteczny prąd fazowy, porównywalny z pomiarem w "
      + "przewodzie fazowym. Curr:2Hz ustala prąd wyrównania i "
      + "początek profilu, a Foc:IqMax ogranicza cały wektor prądu."
      + "\n"
      + "Dobierz If:Damp. Obserwuj Estim:Freq, bo to jedyny odczyt prędkości "
      + "niezależny od rampy. Jeżeli prędkość faluje wokół zadanej, zwiększaj tłumienie "
      + "małymi krokami. Szukaj najmniejszej wartości, która wygasza wahania bez "
      + "wzbudzania nowych. Zero wyłącza tłumienie."
      + "\n"
      + "If:CatchFreq wybiera sposób rozruchu. Przy wartości zero wirnik jest ustawiany "
      + "pod znanym kątem przez czas Drive:AlignTime. Przy wartości dodatniej silnik "
      + "rozpędza się według tabeli Volt. Po osiągnięciu tej częstotliwości sterowanie "
      + "przejmuje pętla prądowa."
      + "\n"
      + "Zakończ etap, gdy w wymaganym zakresie prąd zmierzony zgadza się z zadanym, a "
      + "praca jest stabilna i bez oscylacji." },

  { id: "obs", label: "4 Obserwator",
    find: "Obs:|Pll:",
    mute: EC_MUTE,
    plot: ["Obs:Bias", "Sync:ErrPeak", "Obs:OmegaHat", "Sync:Err"], big: ["Obs:Bias"],
    text:
      "Cel: sprawdzić działanie obserwatora bez przekazywania mu sterowania. Pozostaw "
      + "Drive:Mode = if. Obserwator działa wtedy w tle. Sprawdź cały planowany zakres "
      + "częstotliwości przejęcia i porównuj Obs:OmegaHat z "
      + "Feedback:RenderFreq. Zapisz Sync:ErrPeak na każdej częstotliwości: punkt "
      + "przejęcia wybierzesz tam, gdzie jest najmniejszy."
      + "\n"
      + "Dobierz Obs:DtComp. Obserwuj Obs:Bias i Sync:ErrPeak. Utrzymuj stałą "
      + "prędkość, zacznij od zera i zwiększaj wartość co 10 punktów. Po każdej zmianie "
      + "odczekaj kilka sekund, bo oba odczyty są uśrednione, a szczyt opada powoli. "
      + "Wybierz wartość, przy której Obs:Bias jest najbliżej zera, a "
      + "Sync:ErrPeak najmniejszy. Jeżeli szczyt rośnie już od pierwszego kroku, zostaw "
      + "zero. Dodatni Obs:Bias oznacza, że obserwator zawyża prędkość względem rampy, "
      + "a ujemny, że ją zaniża."
      + "\n"
      + "Nie zeruj Obs:AngleErr za pomocą Obs:DtComp. Ten odczyt zawiera również "
      + "naturalny kąt obciążenia silnika. Do oceny kompensacji czasu martwego służy "
      + "Obs:Bias."
      + "\n"
      + "Jeżeli jedna wartość Obs:DtComp nie utrzymuje Obs:Bias blisko zera w całym "
      + "zakresie, wróć do Motor:Ke, Sense:PhaseMap i skali pomiaru prądu. Nie "
      + "zwiększaj tolerancji warunków przejęcia, aby ukryć błędną estymację."
      + "\n"
      + "Obs:HpHz, Pll:Bw i Pll:Damp zostaw na koniec. Zmieniaj je dopiero wtedy, gdy "
      + "Obs:Bias jest już bliski zeru, a Sync:ErrPeak nadal za wysoki. Obserwuj te "
      + "same dwa odczyty. Zwiększenie Pll:Bw pozwala estymacie nadążać za tętnieniem "
      + "i zwykle obniża Sync:ErrPeak. Zwiększaj wartość stopniowo, dopóki Obs:Bias nie "
      + "zacznie rosnąć; jej zmniejszenie stabilizuje estymatę."
      + "\n"
      + "Zakończ etap, gdy Obs:OmegaHat stabilnie podąża za Feedback:RenderFreq, a "
      + "Obs:Bias pozostaje blisko zera w całym zakresie przejęcia." },

  { id: "sync", label: "5 Przejęcie",
    find: "Foc:Entry|Foc:Lock|If:Fallback|Sync:",
    mute: EC_MUTE,
    plot: ["Sync:Lock", "Sync:LockPeak", "Sync:Err", "Sync:ErrPeak", "Foc:LockErr",
      "Obs:OmegaHat"], big: ["Sync:Lock"],
    text:
      "Cel: zapewnić powtarzalne przekazanie sterowania obserwatorowi. Najpierw pozostaw "
      + "Drive:Mode = if i potwierdź zakres, w którym Obs:OmegaHat stabilnie "
      + "podąża za Feedback:RenderFreq, Obs:Bias jest blisko zera, a Sync:ErrPeak "
      + "pozostaje niski. Jeżeli te warunki nie są spełnione, wróć do strojenia "
      + "obserwatora."
      + "\n"
      + "Ustaw Foc:EntryFreq na częstotliwość, przy której Sync:ErrPeak był najmniejszy. "
      + "If:FallbackFreq ustaw wyraźnie niżej. Odstęp między nimi zapobiega ciągłemu "
      + "przełączaniu między I/f a FOC. Nawet gdy wartość zadana jest niższa, napęd "
      + "najpierw osiągnie Foc:EntryFreq, zamknie pętlę i dopiero potem zejdzie do celu."
      + "\n"
      + "Pierwszą próbę wykonaj bez obciążenia przy Drive:Mode = foc. Podczas "
      + "prawidłowego przejęcia Drive:Stage zmienia się z forced na closed bez skoku "
      + "prądu ani powrotu do I/f. Sync:Lock pokazuje bieżący postęp, a Sync:LockPeak "
      + "jego wartość szczytową, która opada powoli i pozostaje widoczna również przy "
      + "wolnym odpytywaniu."
      + "\n"
      + "Przejęcie oceniaj przede wszystkim po Sync:ErrPeak. Sync:Err jest wartością "
      + "uśrednioną i może wyglądać poprawnie mimo chwilowych skoków błędu. Jeżeli "
      + "Sync:Lock nie rośnie, sprawdź również różnicę prędkości oraz częstotliwość "
      + "pracy względem If:FallbackFreq."
      + "\n"
      + "Foc:LockErr określa dopuszczalny chwilowy błąd kąta w tych samych stopniach co "
      + "Sync:ErrPeak. Ustaw go kilka stopni powyżej zmierzonego szczytu. "
      + "Foc:LockSpeed określa dopuszczalną różnicę prędkości w procentach "
      + "częstotliwości; porównuj ją z Obs:Bias. Nie rozszerzaj tych tolerancji "
      + "wyłącznie po to, aby wymusić przejście do closed. Ustawienie Foc:LockErr na "
      + "zero wyłącza przejęcie: napęd nie zatrzymuje się wtedy na Foc:EntryFreq i "
      + "pracuje dalej z wymuszonym kątem."
      + "\n"
      + "Foc:EntryTimeout ogranicza oczekiwanie na przejęcie po osiągnięciu "
      + "Foc:EntryFreq. Zero oznacza brak limitu czasu. Wartość dodatnia kończy nieudaną "
      + "próbę błędem sync po zadanym czasie."
      + "\n"
      + "Zakończ etap, gdy przejęcie powtarza się bez powrotów do I/f i skoków prądu." },

  { id: "foc", label: "6 FOC",
    find: "Foc:Curr|Foc:Iq|Foc:Mod|Foc:Flags|SpeedCtrl:",
    mute: EC_MUTE,
    plot: ["Foc:IqCmd", "Obs:OmegaHat", "Feedback:ModIndex", "Obs:Bias"], big: ["Foc:IqCmd"],
    text:
      "Cel: dostroić pętlę zamkniętą. Przy Drive:Stage = closed kąt "
      + "elektryczny wyznacza obserwator, a regulator prędkości wyznacza wartość zadaną "
      + "prądu osi q. Foc:IqMax ogranicza prąd wytwarzający moment."
      + "\n"
      + "Foc:CurrBw ustala pasmo pętli prądowej, a jej wzmocnienia wynikają z Motor:Rs "
      + "i Motor:Lq. Zacznij od wartości domyślnej. Zmieniaj ją tylko wtedy, gdy "
      + "odpowiedź prądu jest zbyt wolna albo zaczyna falować. Obserwuj Foc:IqCmd i "
      + "MeasCtrl:CurrAvg: wartości zadana i zmierzona powinny się pokrywać."
      + "\n"
      + "Foc:ModCeil utrzymuje zapas modulacji i chroni okno próbkowania prądu. Nie "
      + "przekraczaj 90%. Flaga sat oznacza osiągnięcie tego limitu i sama nie jest "
      + "błędem."
      + "\n"
      + "Foc:Flags utrzymuje przez około 2s informację o krótkotrwałych zdarzeniach: "
      + "regen oznacza ograniczenie momentu hamującego, limit oznacza osiągnięcie "
      + "Foc:IqMax, a sat oznacza osiągnięcie limitu modulacji. Dzięki temu zdarzenie "
      + "pozostaje widoczne mimo wolnego odpytywania."
      + "\n"
      + "Pętlę prędkości strój na końcu. Dobieraj SpeedCtrl:Kp i SpeedCtrl:Ki, zmieniając "
      + "po jednym parametrze. Obserwuj Obs:OmegaHat i Foc:IqCmd po skoku wartości "
      + "zadanej. SpeedCtrl:Kp ustala szybkość reakcji, a SpeedCtrl:Ki usuwa uchyb "
      + "ustalony. Jeżeli prędkość zaczyna falować, cofnij ostatnią zmianę i sprawdź "
      + "Obs:Bias."
      + "\n"
      + "Zakończ etap, gdy odpowiedź na zmianę wartości zadanej jest szybka i bez "
      + "oscylacji, a flagi limit i sat pojawiają się tylko przy zamierzonych "
      + "przeciążeniach." },

  { id: "rampy", label: "7 Rampy",
    table: "Rise",
    find: "Rise:|Fall:|Brake:|Freeze:Vdc",
    mute: EC_MUTE,
    plot: ["MeasCtrl:DcBus", "Thresh:DcBusMax", "Freeze:VdcHigh"], big: ["MeasCtrl:DcBus"],
    text:
      "Cel: dobrać tempo rozpędzania i hamowania. Tabela Rise ustala "
      + "tempo rozpędzania, a tabela Fall tempo zwalniania; obie definiuje się w "
      + "punktach częstotliwości. Najpierw ustaw Rise, potem Fall. Po zmianie jednego "
      + "punktu powtarzaj ten sam cykl rozpędzania lub hamowania, aby porównać wyniki."
      + "\n"
      + "Przy rozpędzaniu obserwuj MeasCtrl:CurrAvg, a przy zwalnianiu "
      + "MeasCtrl:DcBus. "
      + "Thresh:DcBusMax to próg zabezpieczenia. Nie podnoś go, aby skompensować "
      + "zbyt gwałtowne hamowanie."
      + "\n"
      + "Przy dużym momencie bezwładności i braku rezystora hamującego "
      + "rampa hamowania z tabeli Fall zwykle musi być łagodniejsza, bo silnik oddaje "
      + "energię do szyny DC. Dobieraj ją na podstawie przebiegu napięcia szyny, nie "
      + "tylko przez porównanie z tabelą Rise. W zamkniętej pętli FOC "
      + "Brake:RegenBand zmniejsza moment hamujący, gdy napięcie zbliża się do górnej "
      + "granicy."
      + "\n"
      + "Próg Freeze:VdcHigh powinien zatrzymać rampę zwalniania przed zadziałaniem "
      + "zabezpieczenia hv+. Po zatrzymaniu rampy Freeze:State pokazuje hv+. Jeżeli jej "
      + "zatrzymania są częste, zmniejsz wartości w tabeli Fall. Jeżeli błąd hv+ "
      + "pojawia się przed zatrzymaniem rampy, obniż Freeze:VdcHigh."
      + "\n"
      + "Zakończ etap, gdy pełne cykle rozpędzania i hamowania przebiegają bez błędów i "
      + "częstych zatrzymań rampy." },
];

const Ectra = {

  id: "ectra-guide",
  title: "Ectra · Strojenie PMSM",
  icon: "📖",
  beside: true,

  _stage: null,

  match(regs) {
    return ["Obs:DtComp", "Sync:Lock", "Drive:Stage"]
      .every(n => regs.some(r => r.name === n));
  },

  // Picking a stage aims the whole app at it;
  // dropping it hands the operator their own view back, filter, charts and ignore list alike.
  pick(id) {
    this._stage = id === this._stage ? null : id;
    const st = EC_STAGES.find(s => s.id === this._stage);
    if(st) {
      Widgets.focus(EC_FIND_ALWAYS + "|" + st.find);
      Widgets.plot(EC_ALWAYS.concat(st.plot), EC_BIG.concat(st.big));
      Widgets.mute(st.mute, ecNamed(st.text).concat(EC_FIND_ALWAYS.split("|")));
      // Three stages work on a table.
      // Asking for it is a courtesy to the panel next door, not a requirement:
      // the guide reads the same either way.
      if(st.table) Widgets.tell("ectra-tables", { table: st.table });
    }
    else Widgets.release();
    try { localStorage.setItem(EC_STAGE_KEY, this._stage || ""); }
    catch(e) { /* per-session */ }
    render();
  },

  // A register named in the prose, and a way to it.
  // Hovering marks that row in the grid, clicking takes you there and leaves it marked.
  // Only a name the map carries becomes a link, so a group prefix stays plain text.
  Name({ of }) {
    if(!Reg.byName(of)) return <b>{of}</b>;
    return (
      <b class="ec-ref" onMouseEnter={() => Widgets.point(of)}
        onClick={() => Widgets.reveal(of)}>{of}</b>
    );
  },

  View() {
    const { Name } = Ectra;
    const stage = EC_STAGES.find(s => s.id === this._stage);
    return (
      <div class="ec">
        <div class="ec-tabs">
          {EC_STAGES.map(s =>
            <button class={cls("ec-tab", s.id === this._stage && "on")}
              onClick={() => Ectra.pick(s.id)}>{s.label}</button>)}
        </div>
        <div class="ec-text" onMouseLeave={() => Widgets.point(null)}>
          {(stage ? stage.text : EC_INTRO).split("\n").map(par =>
            <p>{par.split(/([A-Z][A-Za-z]*:[A-Za-z0-9]+)/).map((t, i) =>
              i % 2 ? <Name of={t} /> : t)}</p>)}
        </div>
      </div>
    );
  },
};

try { Ectra._stage = localStorage.getItem(EC_STAGE_KEY) || null; }
catch(e) { /* defaults stand */ }
if(!EC_STAGES.some(s => s.id === Ectra._stage)) Ectra._stage = null;

Widgets.register(Ectra);

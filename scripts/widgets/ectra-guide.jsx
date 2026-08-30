// scripts/widgets/ectra-guide.jsx

// The tuning book: what to do at each stage of bringing up a PMSM drive, and in
// what order. Prose only, because every knob it could offer is a knob the grid
// already has - and one control in two places is one control too many.
//
// What it does instead is aim the rest of the app. Picking a stage highlights
// the registers that stage tunes, charts what has to be watched while tuning
// them, and drops the groups that take no part in it out of the poll cycle.
// That is the part modra cannot do on its own: it holds no opinion about any
// device, and this file is nothing but an opinion about one.
//
// Tables live in `ectra-tables.jsx`. A table is a shape the grid cannot draw,
// so it earns its own panel; this one earns a column beside the grid, because
// its text and the rows it points at have to be readable together.

const EC_STAGE_KEY = "modra.ectra.stage";

// Groups no page of this book ever tunes: a log, counters, the identity of the
// board, the serial port, the flow table. Still readable and writable, they
// simply stop costing a slot in every cycle, so what IS being tuned comes back
// faster.
//
// `Flow` and `Journal` alone are 367 of 643 registers, and every remaining group
// is between five and twenty-four. That is the whole argument for where this
// list ends: past these, muting buys almost nothing and risks hiding a reading
// that turns out to matter. Filter calibration (`MeasCfg`, `Trim`) stays in
// view for exactly that reason - a wrong current scale is the first stage's
// problem and it would be invisible from here.
const EC_DEAD = [
  "Flow:*", "Journal:*", "Counter:*", "Version:*", "System:*",
  "RS485:*", "Digital:*", "AnalogInput:*", "Failsafe:*",
];

// Skip bands shape a voltage table and nothing else, so only the V/f page keeps
// them. Every page carries its own list, built from the shared floor.
const EC_MUTE_VF = EC_DEAD;
const EC_MUTE = EC_DEAD.concat("Resonance:*");

// Every register a page names in its own prose. The page talks about it, so the
// page has to keep it arriving: an instruction pointing at a row frozen at its
// last value is worse than no instruction. Derived from the text rather than
// listed beside it, because a list beside it is a list that goes stale.
const ecNamed = (text) => text.match(/[A-Z][A-Za-z]*:[A-Za-z0-9]+/g) || [];

// Lit in the grid at every stage. How the drive is commanded, what it made of
// that, and how a fault is cleared belong to no single step: they are how you
// start, stop and recover at each of them, and a stage that hid them would be a
// stage you cannot leave.
//
// `Drive:Stage` earns its place twice over. `Drive:Mode` is what you asked for
// and `Drive:Stage` is what the drive did with it, and the two disagree exactly
// when something is wrong: missing motor constants drop a vector run to `obs`,
// a bad current channel to `guard`. Reading the request without the answer is
// how an hour goes into tuning a mode that never engaged.
const EC_FIND_ALWAYS =
  "Ctrl:Mode|Ctrl:Setpoint|Drive:Mode|Drive:Stage|Fault:Code|Fault:Clear";

// Charted at every stage: what the drive was asked for, what it rendered, what
// came back from the meters, and the two readings that end a run badly.
const EC_ALWAYS = [
  "Feedback:SetpointFreq", "Feedback:RenderFreq", "MeasCtrl:Freq",
  "MeasCtrl:CurrAvg", "MeasCtrl:PeakMax", "MeasCtrl:Temp",
  // Charted as well as lit, because the counters beside it say how many
  // takeovers and fallbacks there were and never when. A stepped trace of the
  // stage is the only place a drop out of `closed` has a time on it.
  "Drive:Stage",
];

// Panels are small unless a reading earns otherwise. The operating point always
// does: it is the one trace that says whether the drive is doing what was
// asked. Each stage adds the single reading it is tuning against.
const EC_BIG = ["Feedback:RenderFreq"];

// `\n` starts a paragraph. `find` is a strict search query, `|` joining
// alternatives, so a stage leaves exactly its own registers lit in the grid.
// `table` is the one the tables panel is asked to open, where the stage works
// on one.
const EC_INTRO =
  "Ten panel prowadzi przez pierwsze uruchomienie i strojenie napędu PMSM. Wybierz "
  + "etap, a Modra pokaże potrzebne rejestry i wykresy. Kliknij aktywny etap jeszcze "
  + "raz, żeby wrócić do własnego widoku."
  + "\n"
  + "Ctrl:Mode wybiera źródło i jednostkę zadania: wejście analogowe, procent, rpm "
  + "albo Hz. Wartość off kończy próbę. Ctrl:Setpoint jest wartością w wybranej "
  + "jednostce, dlatego te dwa rejestry zawsze czytaj razem."
  + "\n"
  + "Drive:Mode wybiera tor sterowania: vf korzysta z tabeli Volt, if prowadzi "
  + "wymuszony wektor prądu, a foc przechodzi z I/f do pętli zamkniętej. Drive:Stage "
  + "pokazuje tor, który rzeczywiście pracuje. Jeśli sterowanie wektorowe nie może się "
  + "włączyć, ten rejestr podaje przyczynę."
  + "\n"
  + "Nazwy rejestrów w tekście są klikalne. Najedź, żeby wskazać wiersz w siatce, "
  + "albo kliknij, żeby do niego przejść.";

const EC_STAGES = [

  { id: "dane", label: "1 Dane",
    find: "Motor:|Sense:PhaseMap|Sense:Shunt",
    mute: EC_MUTE,
    plot: ["Foc:GuardId", "Foc:GuardIdRef"], big: [],
    text:
      "Zacznij od danych silnika i toru pomiaru prądu. Bez Motor:Rs sterowanie wektorowe "
      + "się nie włączy. Bez Motor:Ke może pracować I/f, ale FOC nie przejmie wirnika. "
      + "Nie idź dalej, dopóki MeasCtrl:CurrAvg nie zgadza się z miernikiem na przewodzie."
      + "\n"
      + "Motor:Rs zmierz między fazami na zaciskach falownika, razem z kablem, i wpisz "
      + "połowę wyniku. Motor:Lq zmierz tak samo miernikiem LCR w paśmie od 100Hz do "
      + "1kHz. Obróć wał, znajdź największy odczyt i również podziel go przez dwa."
      + "\n"
      + "Motor:PolePairs to liczba par biegunów, nie liczba biegunów. Motor:Ke podaj jako "
      + "międzyfazowe napięcie RMS przypadające na 1000rpm, z tabliczki albo z pomiaru "
      + "wybiegu przy odłączonym mostku."
      + "\n"
      + "Motor:Invert zmienia kierunek obrotów. Sense:PhaseMap opisuje znaki i kolejność "
      + "kanałów prądowych na płytce. To dwa niezależne ustawienia: zamiana przewodów silnika "
      + "nie zmienia torów pomiarowych falownika."
      + "\n"
      + "Jeśli Drive:Stage pokazuje guard, porównaj Foc:GuardId z Foc:GuardIdRef. Wynik bliski "
      + "zera kieruje do okablowania lub martwego kanału, przeciwny znak do polaryzacji, a "
      + "inny wyraźny rozjazd do sprawdzenia Sense:PhaseMap. Zmieniaj jedną rzecz i powtarzaj "
      + "krótki start."
      + "\n"
      + "Na końcu sprawdź Sense:ShuntRes i Sense:ShuntGain. Zła skala nie musi zgłosić błędu, "
      + "ale zafałszuje tabelę Curr, limity prądu i wszystkie późniejsze pomiary." },

  { id: "vf", label: "2 V/f",
    table: "Volt",
    find: "Volt:|MeasCtrl:CurrAvg|Drive:InitFreq",
    mute: EC_MUTE_VF,
    plot: ["Feedback:Volt", "Feedback:ModIndex"], big: ["MeasCtrl:CurrAvg"],
    text:
      "Ustaw Drive:Mode na vf. W tym trybie tabela Volt bezpośrednio wyznacza napięcie "
      + "silnika i nie koryguje go ze sprzężenia. W trybach if i foc ta sama tabela prowadzi "
      + "tylko początek rozruchu, gdy If:CatchFreq jest większe od zera."
      + "\n"
      + "Utrzymuj stałą prędkość i zmieniaj najbliższy punkt tabeli o jeden krok w dół albo w "
      + "górę. Po każdej zmianie poczekaj na ustalenie MeasCtrl:CurrAvg. Wybierz najniższy "
      + "powtarzalny prąd. Meas:CurrAvg jest wolnym odczytem dla deratingu i do tej regulacji "
      + "reaguje zbyt późno."
      + "\n"
      + "Zielona linia pokazuje bieżącą częstotliwość, a zielona kropka napięcie rzeczywiście "
      + "podane. Poniżej Volt:2Hz napięcie schodzi liniowo do zera, dlatego ten punkt najmocniej "
      + "wpływa na obciążony start i końcówkę zatrzymania."
      + "\n"
      + "Tutaj sprawdzasz też sam rozruch. Rampa startuje od Drive:InitFreq i pierwszy moment "
      + "musi dać tabela, bo nic jeszcze nie reguluje prądu. Gdy silnik nie odrywa się od "
      + "postoju, rozstrzyga się to między tą częstotliwością a Volt:2Hz: za nisko i za chudo "
      + "znaczy brak momentu, za bogato znaczy prąd i próg stall." },

  { id: "if", label: "3 I/f",
    table: "Curr",
    find: "If:|Curr:|Foc:IqMax|Drive:AlignTime|MeasCtrl:CurrAvg",
    mute: EC_MUTE,
    plot: ["Foc:IqCmd", "Feedback:Volt", "Obs:AngleErr"], big: ["Foc:IqCmd"],
    text:
      "Ustaw Drive:Mode na if i zacznij od małej częstotliwości bez obciążenia. Tabela Curr "
      + "zadaje prąd, a kąt nadal prowadzi rampa. Poprawnym stanem jest Drive:Stage = forced. "
      + "Obserwator pracuje wtedy w tle, ale jeszcze nie steruje silnikiem."
      + "\n"
      + "Foc:IqCmd pokazuje zastosowane zadanie prądu. Po ustaleniu biegu MeasCtrl:CurrAvg "
      + "powinien być do niego zbliżony. Duży rozjazd oznacza, że pętla prądowa nie dowozi "
      + "zadania. Najpierw sprawdź skalę pomiaru i zapas napięcia, zamiast poprawiać pod to "
      + "tabelę Curr."
      + "\n"
      + "Rejestry prądowe w amperach podają RMS fazy, czyli wielkość porównywalną z miernikiem "
      + "na przewodzie. Curr:2Hz ustala prąd wyrównania i początek profilu, a Foc:IqMax "
      + "ogranicza cały wektor prądu."
      + "\n"
      + "Jeśli prędkość kołysze się wokół zadanej, zwiększaj If:Damp małymi krokami. Szukaj "
      + "najmniejszej wartości, która uspokaja przebieg i nie daje nowych oscylacji. Wartość "
      + "zero wyłącza tłumienie."
      + "\n"
      + "If:CatchFreq wybiera sposób startu. Wartość zero uruchamia align przez czas "
      + "Drive:AlignTime. Wartość dodatnia rozpędza silnik tabelą Volt i przy tej częstotliwości "
      + "przekazuje go pętli prądowej."
      + "\n"
      + "If:MaxFreq jest sufitem pracy na wymuszonym wektorze. Po dojściu do niego rampa staje, "
      + "a Freeze:State pokazuje hold." },

  { id: "obs", label: "4 Obserwator",
    find: "Obs:|Pll:",
    mute: EC_MUTE,
    plot: ["Obs:Bias", "Obs:OmegaHat", "Obs:AngleErr", "Sync:Err"], big: ["Obs:Bias"],
    text:
      "Zostań w Drive:Mode = if. Obserwator liczy wtedy w tle, więc możesz go sprawdzić bez "
      + "oddawania mu sterowania. Przejedź całe planowane pasmo przejęcia i porównuj "
      + "Obs:OmegaHat z Feedback:RenderFreq."
      + "\n"
      + "Na stałej prędkości zmieniaj Obs:DtComp małymi krokami, aż Obs:Bias pozostanie blisko "
      + "zera w całym używanym zakresie. Wartość dodatnia oznacza, że obserwator liczy szybciej "
      + "od rampy, a ujemna, że wolniej."
      + "\n"
      + "Nie zeruj Obs:AngleErr za pomocą Obs:DtComp. Ten odczyt zawiera również naturalny kąt "
      + "obciążenia silnika. Do kompensacji czasu martwego służy Obs:Bias."
      + "\n"
      + "Jeśli jedna nastawa nie daje rozsądnego Obs:Bias w całym paśmie, wróć do Motor:Ke, "
      + "Sense:PhaseMap i skali prądu. Nie poszerzaj bramek przejęcia, żeby ukryć zły przebieg."
      + "\n"
      + "Obs:HpHz, Pll:Bw i Pll:Damp zostaw na koniec. Ruszaj je dopiero wtedy, gdy estymata "
      + "nadal dryfuje albo faluje mimo poprawnego Obs:Bias." },

  { id: "sync", label: "5 Przejęcie",
    find: "Foc:Entry|Foc:Lock|If:Fallback|Sync:",
    mute: EC_MUTE,
    plot: ["Sync:Lock", "Sync:LockPeak", "Sync:Err", "Sync:ErrPeak", "Foc:LockErr",
      "Obs:OmegaHat"], big: ["Sync:Lock"],
    text:
      "Najpierw zostań w Drive:Mode = if i znajdź zakres, w którym Obs:OmegaHat stabilnie "
      + "podąża za Feedback:RenderFreq, Obs:Bias jest blisko zera, a Sync:ErrPeak pozostaje "
      + "niski. Jeśli te warunki nie są spełnione, wróć do strojenia obserwatora."
      + "\n"
      + "Ustaw Foc:EntryFreq wewnątrz tego stabilnego zakresu, a If:FallbackFreq wyraźnie "
      + "niżej. Odstęp między nimi zapobiega ciągłemu przełączaniu między I/f i FOC. Nawet gdy "
      + "zadanie leży niżej, napęd najpierw dojedzie do Foc:EntryFreq, zamknie pętlę i dopiero "
      + "potem zejdzie do celu."
      + "\n"
      + "Do pierwszej próby ustaw Drive:Mode = foc bez obciążenia. Dobry przebieg przechodzi z "
      + "Drive:Stage = forced do closed, bez skoku prądu i bez powrotu do I/f. Sync:Lock "
      + "pokazuje bieżący postęp, a Sync:LockPeak zapamiętuje najlepszy wynik między odczytami."
      + "\n"
      + "Przy ocenie przejęcia patrz przede wszystkim na Sync:ErrPeak. Sync:Err jest wartością "
      + "uśrednioną i może wyglądać dobrze mimo krótkich szpilek. Jeśli Sync:Lock nie rośnie, "
      + "sprawdź również różnicę prędkości i położenie względem If:FallbackFreq."
      + "\n"
      + "Foc:LockErr określa dopuszczalny błąd kąta, a Foc:LockSpeed dopuszczalną różnicę "
      + "prędkości. Nie zwiększaj ich tylko po to, żeby wymusić closed. Wartość zero w "
      + "Foc:LockErr wyłącza przejęcie i postój na Foc:EntryFreq."
      + "\n"
      + "Foc:EntryTimeout ogranicza oczekiwanie na Foc:EntryFreq. Wartość zero czeka bez końca, "
      + "a wartość dodatnia kończy nieudaną próbę błędem sync." },

  { id: "foc", label: "6 FOC",
    find: "Foc:Curr|Foc:Id|Foc:Iq|Foc:Mod|Foc:Flags|SpeedCtrl:",
    mute: EC_MUTE,
    plot: ["Foc:IqCmd", "Feedback:ModIndex", "Foc:ModCeil", "Obs:Bias"], big: ["Foc:IqCmd"],
    text:
      "W Drive:Stage = closed kąt prowadzi obserwator, a regulator prędkości wyznacza prąd iq. "
      + "Foc:IdRef ustala prąd osi strumienia i dla silnika PMSM z magnesami powierzchniowymi "
      + "zwykle pozostaje równy zero. Foc:IqMax ogranicza prąd wytwarzający moment."
      + "\n"
      + "Foc:CurrBw ustala szybkość pętli prądowej, a jej wzmocnienia wynikają z Motor:Rs i "
      + "Motor:Lq. Zacznij od wartości domyślnej. Zmieniaj ją dopiero wtedy, gdy odpowiedź prądu "
      + "jest wyraźnie za wolna albo zaczyna być nerwowa."
      + "\n"
      + "Foc:ModCeil zostawia zapas napięcia i chroni okno próbkowania prądu. Nie przekraczaj "
      + "90%. Flaga sat oznacza, że napęd doszedł do tego sufitu; sama nie jest błędem."
      + "\n"
      + "Foc:Flags zatrzaskuje na około 2s informację o trzech krótkich zdarzeniach: regen "
      + "oznacza ograniczanie hamowania, limit dojście do Foc:IqMax, a sat dojście do limitu "
      + "napięcia. Dzięki temu zdarzenie pozostaje widoczne mimo wolnego odpytywania."
      + "\n"
      + "Pętlę prędkości strój na końcu. Najpierw zmieniaj SpeedCtrl:Kp, który ustala szybkość "
      + "reakcji, a potem SpeedCtrl:Ki, który usuwa stały uchyb. Zmieniaj jedno wzmocnienie na "
      + "raz. Jeśli prędkość zaczyna falować, cofnij ostatnią zmianę i sprawdź Obs:Bias." },

  { id: "rampy", label: "7 Rampy",
    table: "Rise",
    find: "Rise:|Fall:|Brake:|Freeze:Vdc",
    mute: EC_MUTE,
    plot: ["MeasCtrl:DcBus", "Thresh:DcBusMax", "Freeze:VdcHigh"], big: ["MeasCtrl:DcBus"],
    text:
      "Tabela Rise ustala tempo rozpędzania, a Fall tempo zwalniania. Obie działają na "
      + "kotwicach częstotliwości. Najpierw ustaw Rise, potem Fall. Zmieniaj jeden punkt i "
      + "powtarzaj ten sam przejazd, żeby wyniki dało się porównać."
      + "\n"
      + "Przy rozpędzaniu obserwuj prąd, a przy zwalnianiu MeasCtrl:DcBus. Thresh:DcBusMax jest "
      + "granicą zabezpieczenia, nie pokrętłem do strojenia rampy. Nie podnoś go, żeby ukryć "
      + "zbyt ostre hamowanie."
      + "\n"
      + "Przy bezwładnym obciążeniu i bez rezystora hamującego Fall zwykle musi być łagodniejsza, "
      + "bo silnik oddaje energię do szyny DC. Decyduje przebieg napięcia, nie sama relacja do "
      + "Rise. W zamkniętym FOC Brake:RegenBand zmniejsza moment hamujący, gdy napięcie zbliża "
      + "się do górnej granicy."
      + "\n"
      + "Freeze:VdcHigh powinno zatrzymać zwalnianie przed błędem hv+. Gdy działa, Freeze:State "
      + "pokazuje hv+. Jeśli zatrzymania powtarzają się często, zmniejsz wartości w tabeli Fall. "
      + "Jeśli błąd pojawia się przed zamrożeniem, obniż Freeze:VdcHigh." },
];

const Ectra = {

  id: "ectra-guide",
  title: "Ectra · Guide",
  icon: "📖",
  beside: true,

  _stage: null,

  match(regs) {
    return ["Obs:DtComp", "Sync:Lock", "Drive:Stage"]
      .every(n => regs.some(r => r.name === n));
  },

  // Picking a stage aims the whole app at it; dropping it hands the operator
  // their own view back, filter, charts and ignore list alike.
  pick(id) {
    this._stage = id === this._stage ? null : id;
    const st = EC_STAGES.find(s => s.id === this._stage);
    if(st) {
      Widgets.focus(EC_FIND_ALWAYS + "|" + st.find);
      Widgets.plot(EC_ALWAYS.concat(st.plot), EC_BIG.concat(st.big));
      Widgets.mute(st.mute, ecNamed(st.text).concat(EC_FIND_ALWAYS.split("|")));
      // Three stages work on a table. Asking for it is a courtesy to the panel
      // next door, not a requirement: the guide reads the same either way.
      if(st.table) Widgets.tell("ectra-tables", { table: st.table });
    }
    else Widgets.release();
    try { localStorage.setItem(EC_STAGE_KEY, this._stage || ""); }
    catch(e) { /* per-session */ }
    render();
  },

  // A register named in the prose, and a way to it. Hovering marks that row in
  // the grid, clicking takes you there and leaves it marked. Only a name the
  // map carries becomes a link, so a group prefix stays plain text.
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


    async function callGeminiServer(payload) {
      const response = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        let message = `HTTP error! status: ${response.status}`;
        const errorText = await response.text();
        if (errorText && errorText.trim()) {
          try {
            const errorPayload = JSON.parse(errorText);
            if (errorPayload && typeof errorPayload.error === 'string' && errorPayload.error.trim()) {
              message = errorPayload.error.trim();
            } else {
              message = errorText.trim();
            }
          } catch (jsonError) {
            message = errorText.trim();
          }
        }
        throw new Error(message);
      }
      return response.json();
    }

    async function callGeminiAPI(userPrompt, systemPrompt = "", expectJson = false) {
      const payload = {
        contents: [{ parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
      };

      if (expectJson) {
        payload.generationConfig = { responseMimeType: "application/json" };
      }

      const maxRetries = 5;
      const delays = [1000, 2000, 4000, 8000, 16000];

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await callGeminiServer(payload);
          return result.candidates?.[0]?.content?.parts?.[0]?.text;
        } catch (error) {
          if (attempt === maxRetries - 1) {
            console.error("AI API failed after retries:", error);
            throw error;
          }
          await new Promise(res => setTimeout(res, delays[attempt]));
        }
      }
    }

    function toggleAILoader(show) {
      const loader = document.getElementById('aiLoaderOverlay');
      if (show) loader.classList.add('active');
      else loader.classList.remove('active');
    }

    function detectPdfFormat(base64Data) {
      try {
        const sample = atob(String(base64Data || '').slice(0, 500000));
        return {
          hasXfa: sample.includes('/XFA'),
          hasAcroForm: sample.includes('/AcroForm'),
          hasPleaseWait: sample.includes('Please wait')
        };
      } catch (error) {
        return { hasXfa: false, hasAcroForm: false, hasPleaseWait: false };
      }
    }

    function xfaPdfErrorMessage() {
      return "Tento PDF soubor je interaktivní formulář (XFA) a aplikace ho neumí spolehlivě přečíst.\n\nOtevřete ho v Adobe Readeru a použijte:\nTisk -> Microsoft Print to PDF\n\nPotom nahrajte nově vytvořený PDF soubor.";
    }

    function handleClientPdfUpload(event) {
      const file = event.target.files[0];
      if (!file) return;

      toggleAILoader(true);

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64Data = reader.result.split(',')[1];
          const pdfFormat = detectPdfFormat(base64Data);
          if (pdfFormat.hasXfa) {
            alert(xfaPdfErrorMessage());
            return;
          }
          await processClientPdfWithGemini(base64Data);
        } catch (err) {
          console.error(err);
          alert(`Při zpracování PDF pomocí AI došlo k chybě.\n\n${err.message || 'Neznámá chyba.'}`);
        } finally {
          toggleAILoader(false);
          event.target.value = '';
        }
      };
      reader.onerror = error => {
        console.error("Error reading file:", error);
        alert("Nepodařilo se přečíst soubor.");
        toggleAILoader(false);
        event.target.value = '';
      };

      reader.readAsDataURL(file);
    }

    async function processClientPdfWithGemini(base64Data) {
      const systemPrompt = `Jsi expertní asistent v dluhové poradně. Analyzuj přiložený dokument (Návrh na povolení oddlužení nebo obdobný) a vyčti z něj údaje o dlužníkovi a POKUD JSOU V DOKUMENTU, TAK I SEZNAM ZÁVAZKŮ.
Vždy vrať pouze validní JSON objekt.
Klíče JSON objektu musí být přesně tyto:
- jmeno_klienta (string): Jméno a příjmení.
- rok_narozeni (string): Pouze rok narození (např. "1980").
- telefon (string): Telefonní číslo.
- email (string): E-mailová adresa.
- vyzivovane_osoby (number): Počet vyživovaných osob. Výchozí je 0.
- zamestnani_status (string): Přípustné hodnoty jsou POUZE: "zamestnany", "nezamestnany", "osvc", "rodicovska", "invalidni_duchod", "starobni_duchod". Pokud nevíš, vrať "zamestnany".
- hlavni_zdroj_prijmu (string): Název zaměstnavatele, typ důchodu nebo dávky.
- obligations (array): Pole objektů, kde každý objekt představuje jeden dluh/závazek. Struktura objektu:
   - veritel_nazev (string)
   - vyse_dluhu (number)
   - datum_vzniku_dluhu (string)
   - oblast_dluhu (string): Vyber POUZE: "bydlení", "mikropůjčka", "státní sektor", "pokuty", "z podnikání", "výživné", "další".
   - stav_dluhu (string): Vyber POUZE: "ohrožena splatnost", "po splatnosti", "exekuce".
Pokud nějaký údaj nenajdeš, vrať prázdné hodnoty. Pokud nenajdeš závazky, vrať u 'obligations' prázdné pole []. Nevymýšlej si údaje.`;

      const payload = {
        contents: [{
          parts: [
            { text: "Analyzuj tento PDF dokument a extrahuj z něj údaje o klientovi do JSONu." },
            { inlineData: { mimeType: "application/pdf", data: base64Data } }
          ]
        }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
      };

      const maxRetries = 5;
      const delays = [1000, 2000, 4000, 8000, 16000];
      let responseText = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await callGeminiServer(payload);
          responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
          break;
        } catch (error) {
          if (attempt === maxRetries - 1) throw error;
          await new Promise(res => setTimeout(res, delays[attempt]));
        }
      }

      if (responseText) {
        const parsedData = JSON.parse(responseText);
        const foundClient = parsedData.jmeno_klienta && parsedData.jmeno_klienta.trim() !== "";
        const foundObligations = parsedData.obligations && parsedData.obligations.length > 0;

        if (!foundClient && !foundObligations) {
          alert("AI prošla dokument, ale nenašla v něm žádné použitelné údaje.");
          return;
        }

        appData.client.jmeno_klienta = parsedData.jmeno_klienta || appData.client.jmeno_klienta;
        appData.client.rok_narozeni = parsedData.rok_narozeni || appData.client.rok_narozeni;
        appData.client.telefon = parsedData.telefon || appData.client.telefon;
        appData.client.email = parsedData.email || appData.client.email;
        if (parsedData.vyzivovane_osoby !== undefined) appData.client.vyzivovane_osoby = parsedData.vyzivovane_osoby;
        appData.client.zamestnani_status = parsedData.zamestnani_status || appData.client.zamestnani_status;
        appData.client.hlavni_zdroj_prijmu = parsedData.hlavni_zdroj_prijmu || appData.client.hlavni_zdroj_prijmu;

        let alertMsg = `Úspěch! AI analyzovala údaje a předvyplnila klienta: ${appData.client.jmeno_klienta}.`;

        if (foundObligations) {
          appData.obligations = [...appData.obligations, ...parsedData.obligations.map(o => ({
            id: '',
            veritel_nazev: o.veritel_nazev || 'Neznámý',
            vyse_dluhu: o.vyse_dluhu || 0,
            datum_vzniku_dluhu: o.datum_vzniku_dluhu || '',
            oblast_dluhu: o.oblast_dluhu || 'další',
            stav_dluhu: o.stav_dluhu || 'po splatnosti'
          }))];
          alertMsg += `\nZároveň bylo načteno ${parsedData.obligations.length} závazků do listu Závazky.`;
        }

        saveCollectionsAndRefresh();
        alert(alertMsg);
      } else {
        throw new Error("Nepodařilo se získat odpověď od API.");
      }
    }

    function handlePdfUpload(event) {
      const file = event.target.files[0];
      if (!file) return;

      toggleAILoader(true);

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64Data = reader.result.split(',')[1];
          const pdfFormat = detectPdfFormat(base64Data);
          if (pdfFormat.hasXfa) {
            alert(xfaPdfErrorMessage());
            return;
          }
          await processPdfWithGemini(base64Data);
        } catch (err) {
          console.error(err);
          alert(`Při zpracování PDF pomocí AI došlo k chybě.\n\n${err.message || 'Neznámá chyba.'}`);
        } finally {
          toggleAILoader(false);
          event.target.value = '';
        }
      };
      reader.onerror = error => {
        console.error("Error reading file:", error);
        alert("Nepodařilo se přečíst soubor.");
        toggleAILoader(false);
        event.target.value = '';
      };

      reader.readAsDataURL(file);
    }

    async function processPdfWithGemini(base64Data) {
      const systemPrompt = `Jsi expertní asistent pro zpracování dat v dluhové poradně. Tvojí úlohou je analyzovat přiložený dokument a vyčíst z něj seznam závazků do JSON formátu.
Vždy vrať pouze JSON objekt obsahující pole 'obligations'.
Každý objekt v poli ať má strukturu:
- veritel_nazev (string)
- vyse_dluhu (number)
- datum_vzniku_dluhu (string)
- oblast_dluhu (string): Vyber POUZE jednu z hodnot: "bydlení", "mikropůjčka", "státní sektor", "pokuty", "z podnikání", "výživné", "další".
- stav_dluhu (string): Vyber POUZE jednu z hodnot: "ohrožena splatnost", "po splatnosti", "exekuce".`;

      const payload = {
        contents: [{
          parts: [
            { text: "Analyzuj tento PDF dokument a extrahuj z něj všechny závazky do JSONu." },
            { inlineData: { mimeType: "application/pdf", data: base64Data } }
          ]
        }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
      };

      const maxRetries = 5;
      const delays = [1000, 2000, 4000, 8000, 16000];
      let responseText = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await callGeminiServer(payload);
          responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
          break;
        } catch (error) {
          if (attempt === maxRetries - 1) throw error;
          await new Promise(res => setTimeout(res, delays[attempt]));
        }
      }

      if (responseText) {
        const parsedData = JSON.parse(responseText);
        if (parsedData && Array.isArray(parsedData.obligations) && parsedData.obligations.length > 0) {
          appData.obligations = [...appData.obligations, ...parsedData.obligations.map(o => ({
            id: '',
            veritel_nazev: o.veritel_nazev || 'Neznámý',
            vyse_dluhu: o.vyse_dluhu || 0,
            datum_vzniku_dluhu: o.datum_vzniku_dluhu || '',
            oblast_dluhu: o.oblast_dluhu || 'další',
            stav_dluhu: o.stav_dluhu || 'ohrožena splatnost'
          }))];
          saveCollectionsAndRefresh();
          alert(`Úspěch! AI analyzovala PDF dokument a přidala ${parsedData.obligations.length} závazků.`);
        } else {
          alert("AI prošla dokument, ale nenašla v něm žádné konkrétní závazky.");
        }
      } else {
        throw new Error("Nepodařilo se získat odpověď od API.");
      }
    }

    async function generateReportWithAI() {
      if (!ensureReadyForReport()) return;
      toggleAILoader(true);
      try {
        const systemPrompt = `Jsi profesionální, empatický a věcný sociální a dluhový poradce.
Tvým úkolem je napsat 'Zprávu z mapování předlužení' pro klienta na základě předaných JSON dat.
Struktura zprávy:
1. Celkové shrnutí situace klienta.
2. Přehled závazků.
3. Analýza rizik.
4. Doporučené kroky.
Piš formálně, odstavcově, v češtině. Nepoužívej markdownové bloky, vrať čistý text.`;

        const dataForAI = {
          client: appData.client,
          obligations_summary: debtSummary(),
          obligations_list: appData.obligations,
          budget: appData.budget.enabled ? appData.budget.summary : "Nevyplněno",
          causes: appData.mapping_summary.causes_free_text,
          context: appData.mapping_summary.causes_context_text,
          manual_next_steps: appData.mapping_summary.report_next_steps
        };

        const responseText = await callGeminiAPI(`Vygeneruj zprávu na základě těchto dat klienta: ${JSON.stringify(dataForAI)}`, systemPrompt, false);

        if (responseText) {
          appData.report.generated_text = responseText;
          appData.report.edited_text = responseText;
          touch();
          renderMappingSummary();
          alert('Chytrá zpráva byla vygenerována pomocí AI.');
        }
      } catch (err) {
        console.error(err);
        alert("AI API selhalo. Prosím využijte zatím klasické generování.");
      } finally {
        toggleAILoader(false);
      }
    }

    const MENU = [
      { id: 'client', label: 'Klient', subtitle: 'Základní kontext potřebný pro mapování.' },
      { id: 'obligations', label: 'Závazky', subtitle: 'Jádro mapování závazků.' },
      { id: 'budget', label: 'Příjmy a výdaje', subtitle: 'Rozpočtová kapacita a potenciál.' },
      { id: 'causes', label: 'Příčiny předlužení', subtitle: 'Důvody a dopady předlužení.' },
      { id: 'report', label: 'Zpráva', subtitle: 'Shrnutí mapování, generování a export.' }
    ];

    const STAV_MAPOVANI = ['rozpracovano', 'dokonceno'];
    const BYDLENI_TYPY = ['najem', 'podnajem', 'vlastni', 'ubytovna', 'u_rodiny', 'bez_stabilniho_bydleni'];
    const ZAMESTNANI_STATUSY = ['zamestnany', 'nezamestnany', 'osvc', 'rodicovska', 'invalidni_duchod', 'starobni_duchod', 'brigady_neformalni_prace', 'bez_prijmu'];
    const OBLASTI_DLUHU = ['bydlení', 'mikropůjčka', 'státní sektor', 'pokuty', 'z podnikání', 'výživné', 'další'];
    const STAVY_DLUHU_SIMPLE = ['ohrožena splatnost', 'po splatnosti', 'exekuce'];
    const PRIJEM_TYPY = ['mzda', 'davky', 'duchod', 'vyzivne', 'brigada', 'prispevek_domacnosti', 'jiny'];
    const PRIJEM_PRAVIDELNOST = ['mesicne', 'nepravidelne', 'jednorazove'];
    const JISTOTA_PRIJMU = ['stabilni', 'nejiste', 'kratkodobe'];
    const VYDAJ_TYPY = ['najem', 'energie', 'jidlo', 'doprava', 'telefon', 'leky', 'skola_deti', 'jine'];
    const NEZBYTNOST = ['nezbytne', 'omezitelne', 'volitelne'];
    function nowIso() { return new Date().toISOString(); }

    function newCaseId() {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      const random = Math.random().toString(16).slice(2, 6).toUpperCase();
      return `MAP-${y}${m}${d}-${random}`;
    }

    function defaultCase() {
      const created = nowIso();
      return {
        meta: { schema_version: '1.0', case_id: newCaseId(), stav_mapovani: 'rozpracovano', created_at: created, updated_at: created },
        client: {
          jmeno_klienta: '', rok_narozeni: '', telefon: '', email: '',
          domacnost_dospeli: 1, domacnost_deti: 0, vyzivovane_osoby: 0,
          bydleni_typ: 'najem', bydleni_najemne: 0, bydleni_energie: 0,
          zamestnani_status: 'zamestnany', hlavni_zdroj_prijmu: '',
          zdravotni_socialni_omezeni: '', poznamka_poradce: ''
        },
        obligations: [],
        budget: {
          enabled: false,
          income_items: [], expense_items: [],
          summary: { celkem_prijmy: 0, celkem_vydaje_bez_splatek: 0, celkem_splatky_dluhu: 0, celkem_vydaje_vcetne_splatek: 0, volne_prostredky: 0 }
        },
        causes: [],
        client_registry: { items: [], selected_key: '', search: '', loaded_at: '', error: '' },
        mapping_summary: {
          hlavni_rizika: [], chybejici_podklady: [], causes_free_text: '', causes_context_text: '', report_next_steps: '', missing_docs_text: '',
          hlavni_zjisteni: '', zaver_mapovani: '', doporucene_priority: []
        },
        report: { generated_text: '', edited_text: '' }
      };
    }

    function normalizeAppData(raw) {
      const base = defaultCase();
      const source = raw && typeof raw === 'object' ? raw : {};
      const normalized = {
        ...base,
        ...source,
        meta: { ...base.meta, ...(source.meta || {}) },
        client: { ...base.client, ...(source.client || {}) },
        budget: {
          ...base.budget,
          ...(source.budget || {}),
          enabled: !!(source.budget && source.budget.enabled),
          income_items: Array.isArray(source.budget && source.budget.income_items) ? source.budget.income_items : [],
          expense_items: Array.isArray(source.budget && source.budget.expense_items) ? source.budget.expense_items : [],
          summary: { ...base.budget.summary, ...((source.budget && source.budget.summary) || {}) }
        },
        client_registry: { ...base.client_registry, ...(source.client_registry || {}) },
        mapping_summary: { ...base.mapping_summary, ...(source.mapping_summary || {}) },
        report: { ...base.report, ...(source.report || {}) }
      };

      normalized.obligations = Array.isArray(source.obligations) ? source.obligations : [];
      normalized.causes = Array.isArray(source.causes) ? source.causes : [];
      normalized.client_registry.items = Array.isArray(normalized.client_registry.items) ? normalized.client_registry.items : [];
      normalized.mapping_summary.hlavni_rizika = Array.isArray(normalized.mapping_summary.hlavni_rizika) ? normalized.mapping_summary.hlavni_rizika : [];
      normalized.mapping_summary.chybejici_podklady = Array.isArray(normalized.mapping_summary.chybejici_podklady) ? normalized.mapping_summary.chybejici_podklady : [];
      normalized.mapping_summary.doporucene_priority = Array.isArray(normalized.mapping_summary.doporucene_priority) ? normalized.mapping_summary.doporucene_priority : [];

      return normalized;
    }

    let appData = defaultCase();
    let currentView = 'client';
    let saveTimeout = null;

    function clone(value) { return JSON.parse(JSON.stringify(value)); }

    function safeNumber(value) {
      const num = Number(value);
      return Number.isFinite(num) ? num : 0;
    }

    function fmtCurrency(value) {
      const num = safeNumber(value);
      const sign = num < 0 ? '-' : '';
      return sign + Math.abs(num).toLocaleString('cs-CZ', { maximumFractionDigits: 0 }) + ' Kč';
    }

    function escapeHtml(str) {
      return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function fileSafeText(str) {
      return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);
    }

    function reportFilename(ext) {
      const name = fileSafeText(appData.client?.jmeno_klienta || '') || String(appData.meta.case_id || 'case').toLowerCase();
      return `zprava_z_mapovani_${name}.${ext}`;
    }

    function formatDateForInput(value) {
      if (!value) return '';
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('cs-CZ');
    }

    function normalizeEmploymentStatus(value) {
      const text = String(value || '').toLowerCase().trim();
      if (!text) return 'zamestnany';
      if (text.includes('nezam')) return 'nezamestnany';
      if (text.includes('osvč') || text.includes('osvc') || text.includes('podnik')) return 'osvc';
      if (text.includes('rodič') || text.includes('rodic')) return 'rodicovska';
      if (text.includes('invalid')) return 'invalidni_duchod';
      if (text.includes('starob')) return 'starobni_duchod';
      if (text.includes('brig') || text.includes('neform')) return 'brigady_neformalni_prace';
      if (text.includes('bez příj') || text.includes('bez prij') || text.includes('neaktiv')) return 'bez_prijmu';
      return 'zamestnany';
    }

    function registryClientKey(row) {
      return [row['PROJEKT'], row['Jméno'], row['Příjmení'], row['Datum narození']].map(item => String(item || '').trim()).join('|');
    }

    function registryClientLabel(row) {
      const fullName = [row['Jméno'], row['Příjmení']].filter(Boolean).join(' ').trim() || 'Neznámý klient';
      const meta = [row['PROJEKT'], row['Město'], formatDateForInput(row['Datum narození'])].filter(Boolean).join(' • ');
      return meta ? `${fullName} • ${meta}` : fullName;
    }

    function calculateAge(yearValue) {
      const year = Number(String(yearValue || '').trim());
      const currentYear = new Date().getFullYear();
      if (Number.isFinite(year) && year >= 1900 && year <= currentYear) return String(currentYear - year);
      return 'neuvedeno';
    }

    function calculateBudgetSummary() {
      if (!appData.budget || typeof appData.budget !== 'object') appData.budget = {};
      if (!Array.isArray(appData.budget.income_items)) appData.budget.income_items = [];
      if (!Array.isArray(appData.budget.expense_items)) appData.budget.expense_items = [];
      if (!appData.budget.summary || typeof appData.budget.summary !== 'object') appData.budget.summary = {};
      const incomeTotal = appData.budget.income_items.reduce((sum, item) => sum + safeNumber(item.castka), 0);
      const expenseTotal = appData.budget.expense_items.reduce((sum, item) => sum + safeNumber(item.castka), 0);
      const debtInstallments = 0;
      appData.budget.summary = {
        celkem_prijmy: incomeTotal,
        celkem_vydaje_bez_splatek: expenseTotal,
        celkem_splatky_dluhu: debtInstallments,
        celkem_vydaje_vcetne_splatek: expenseTotal + debtInstallments,
        volne_prostredky: incomeTotal - expenseTotal - debtInstallments
      };
    }

    function debtSummary() {
      return {
        pocet: appData.obligations.length,
        celkem: appData.obligations.reduce((sum, item) => sum + safeNumber(item.vyse_dluhu), 0),
        v_exekuci: appData.obligations.filter(item => item.stav_dluhu === 'exekuce').length,
        po_splatnosti: appData.obligations.filter(item => item.stav_dluhu === 'po splatnosti').length,
      };
    }

    function completionScore() {
      let score = 0; const total = 6;
      if (appData.client.jmeno_klienta) score += 1;
      if (appData.obligations.length) score += 1;
      if (!appData.budget.enabled || appData.budget.income_items.length || appData.budget.expense_items.length) score += 1;
      if (appData.mapping_summary.causes_free_text) score += 1;
      if (appData.mapping_summary.causes_context_text) score += 1;
      if (appData.mapping_summary.report_next_steps || appData.report.generated_text) score += 1;
      return Math.round((score / total) * 100);
    }

    function showToast() {
      const toast = document.getElementById("toast");
      toast.className = "show";
      setTimeout(() => { toast.className = toast.className.replace("show", ""); }, 2000);
    }

    function touch() {
      calculateBudgetSummary();
      appData.meta.updated_at = nowIso();
      localStorage.setItem('auditDataBackupV4', JSON.stringify(appData));
      showToast();
    }

    function debounce(func, wait) {
      return function executedFunction(...args) {
        const later = () => { clearTimeout(saveTimeout); func(...args); };
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(later, wait);
      };
    }

    function syncObligationTotals() {
      appData.obligations = appData.obligations.map(item => ({
        ...item, vyse_dluhu: safeNumber(item.vyse_dluhu)
      }));
    }

    function saveCollectionsAndRefresh() {
      syncObligationTotals();
      touch();
      renderAll();
    }

    function renderMenu() {
      document.getElementById('menu').innerHTML = MENU.map(item => `
        <button class="${currentView === item.id ? 'active' : ''}" type="button" onclick="openView('${item.id}')">${item.label}</button>
      `).join('');
    }

    function openView(viewId) {
      currentView = viewId;
      document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
      document.getElementById(`view-${viewId}`).classList.add('active');
      const menuItem = MENU.find(item => item.id === viewId);
      document.getElementById('pageTitle').textContent = menuItem.label;
      document.getElementById('pageSubtitle').textContent = menuItem.subtitle;
      renderMenu();
    }

    function populateSelect(selectId, options, currentValue) {
      const select = document.getElementById(selectId);
      if (select) {
        select.innerHTML = options.map(option => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
        select.value = currentValue;
      }
    }

    function renderSidebar() {
      document.getElementById('sidebarClientName').textContent = appData.client.jmeno_klienta || 'Nové mapování';
      document.getElementById('sidebarStatus').textContent = appData.meta.stav_mapovani || 'rozpracovano';
      const score = completionScore();
      document.getElementById('sidebarProgress').style.width = `${score}%`;
      document.getElementById('sidebarProgressText').textContent = `Vyplněnost: ${score} %`;
      document.getElementById('lastUpdatedLabel').textContent = appData.meta.updated_at ? `Poslední změna: ${new Date(appData.meta.updated_at).toLocaleString('cs-CZ')}` : 'Bez změn';
    }

    function renderBudgetSection() {
      const enabled = !!appData.budget?.enabled;
      const checkbox = document.getElementById('budget_enabled');
      const content = document.getElementById('budgetContent');
      const notice = document.getElementById('budgetDisabledNotice');
      if (checkbox) checkbox.checked = enabled;
      if (content) content.classList.toggle('hidden', !enabled);
      if (notice) notice.classList.toggle('hidden', enabled);
    }

    function toggleBudgetEnabled(enabled) {
      appData.budget.enabled = !!enabled;
      touch();
      renderBudgetSection();
      renderSidebar();
    }

    function renderClientForm() {
      const c = appData.client;
      document.getElementById('client_jmeno_klienta').value = c.jmeno_klienta || '';
      document.getElementById('client_rok_narozeni').value = c.rok_narozeni || '';
      document.getElementById('client_telefon').value = c.telefon || '';
      document.getElementById('client_email').value = c.email || '';
      document.getElementById('client_domacnost_dospeli').value = c.domacnost_dospeli ?? 1;
      document.getElementById('client_domacnost_deti').value = c.domacnost_deti ?? 0;
      document.getElementById('client_vyzivovane_osoby').value = c.vyzivovane_osoby ?? 0;
      document.getElementById('client_bydleni_najemne').value = c.bydleni_najemne ?? 0;
      document.getElementById('client_bydleni_energie').value = c.bydleni_energie ?? 0;
      document.getElementById('client_hlavni_zdroj_prijmu').value = c.hlavni_zdroj_prijmu || '';
      document.getElementById('client_zdravotni_socialni_omezeni').value = c.zdravotni_socialni_omezeni || '';
      document.getElementById('client_poznamka_poradce').value = c.poznamka_poradce || '';
      populateSelect('meta_stav_mapovani', STAV_MAPOVANI, appData.meta.stav_mapovani || 'rozpracovano');
      populateSelect('client_bydleni_typ', BYDLENI_TYPY, c.bydleni_typ || 'najem');
      populateSelect('client_zamestnani_status', ZAMESTNANI_STATUSY, c.zamestnani_status || 'zamestnany');
      document.getElementById('clientRegistrySearch').value = appData.client_registry?.search || '';
      document.getElementById('client_jmeno_klienta').classList.toggle('input-invalid', !String(c.jmeno_klienta || '').trim());
      renderClientRegistry();
    }

    const saveClientSectionDebounced = debounce(() => {
      appData.client = {
        jmeno_klienta: document.getElementById('client_jmeno_klienta').value.trim(),
        rok_narozeni: document.getElementById('client_rok_narozeni').value.trim(),
        telefon: document.getElementById('client_telefon').value.trim(),
        email: document.getElementById('client_email').value.trim(),
        domacnost_dospeli: safeNumber(document.getElementById('client_domacnost_dospeli').value),
        domacnost_deti: safeNumber(document.getElementById('client_domacnost_deti').value),
        vyzivovane_osoby: safeNumber(document.getElementById('client_vyzivovane_osoby').value),
        bydleni_typ: document.getElementById('client_bydleni_typ').value,
        bydleni_najemne: safeNumber(document.getElementById('client_bydleni_najemne').value),
        bydleni_energie: safeNumber(document.getElementById('client_bydleni_energie').value),
        zamestnani_status: document.getElementById('client_zamestnani_status').value,
        hlavni_zdroj_prijmu: document.getElementById('client_hlavni_zdroj_prijmu').value.trim(),
        zdravotni_socialni_omezeni: document.getElementById('client_zdravotni_socialni_omezeni').value.trim(),
        poznamka_poradce: document.getElementById('client_poznamka_poradce').value.trim()
      };
      appData.meta.stav_mapovani = document.getElementById('meta_stav_mapovani').value;
      touch();
      renderSidebar();
    }, 800);

    function selectOptions(options, currentValue) {
      return options.map(opt => `<option value="${escapeHtml(opt)}" ${opt === currentValue ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('');
    }

    function filteredRegistryItems() {
      const search = String(appData.client_registry?.search || '').toLowerCase().trim();
      const items = Array.isArray(appData.client_registry?.items) ? appData.client_registry.items : [];
      if (!search) return items;
      return items.filter(item => registryClientLabel(item).toLowerCase().includes(search));
    }

    function renderClientRegistry() {
      const select = document.getElementById('clientRegistrySelect');
      const status = document.getElementById('clientRegistryStatus');
      if (!select || !status) return;
      const items = filteredRegistryItems();
      const selected = appData.client_registry?.selected_key || '';
      select.innerHTML = items.length
        ? items.map(item => `<option value="${escapeHtml(registryClientKey(item))}" ${registryClientKey(item) === selected ? 'selected' : ''}>${escapeHtml(registryClientLabel(item))}</option>`).join('')
        : '<option value="">Žádní klienti k zobrazení.</option>';
      const base = appData.client_registry?.error
        ? `Chyba načtení registru: ${appData.client_registry.error}`
        : appData.client_registry?.loaded_at
          ? `Načteno ${Array.isArray(appData.client_registry.items) ? appData.client_registry.items.length : 0} klientů. Poslední načtení: ${new Date(appData.client_registry.loaded_at).toLocaleString('cs-CZ')}.`
          : 'Registr klientů zatím nebyl načten.';
      const suffix = appData.client_registry?.search ? ` Filtr: "${appData.client_registry.search}".` : '';
      status.textContent = base + suffix;
    }

    function updateClientRegistrySearch(value) {
      appData.client_registry.search = value;
      renderClientRegistry();
    }

    function setSelectedRegistryClient(value) {
      appData.client_registry.selected_key = value;
    }

    function handleClientRegistryResponse(items, showFeedback = false) {
      if (!Array.isArray(items)) {
        appData.client_registry.error = 'Odpověď není seznam klientů.';
        renderClientRegistry();
        return;
      }
      appData.client_registry.items = items;
      appData.client_registry.loaded_at = nowIso();
      appData.client_registry.error = '';
      if (!appData.client_registry.selected_key && items.length) appData.client_registry.selected_key = registryClientKey(items[0]);
      renderClientRegistry();
      if (showFeedback) showToast();
    }

    async function loadClientRegistry(showFeedback = false) {
      const status = document.getElementById('clientRegistryStatus');
      if (status) status.textContent = 'Načítám registr klientů...';
      try {
        const response = await fetch('/api/client-registry', {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error || 'Nepodařilo se načíst data registru.');
        }
        const items = await response.json();
        handleClientRegistryResponse(items, showFeedback);
      } catch (error) {
        appData.client_registry.error = error.message || 'Nepodařilo se načíst data.';
        renderClientRegistry();
      }
    }

    function importSelectedClient() {
      const selectedKey = appData.client_registry?.selected_key;
      const row = (appData.client_registry?.items || []).find(item => registryClientKey(item) === selectedKey);
      if (!row) return alert('Nejprve vyberte klienta ze seznamu.');
      const fullName = [row['Jméno'], row['Příjmení']].filter(Boolean).join(' ').trim();
      const extraNotes = [
        row['SPÁDOVÉ MĚSTO'] ? `Spádové město: ${row['SPÁDOVÉ MĚSTO']}` : '',
        row['PROJEKT'] ? `Projekt: ${row['PROJEKT']}` : ''
      ].filter(Boolean);
      appData.client = {
        ...appData.client,
        jmeno_klienta: fullName || appData.client.jmeno_klienta,
        rok_narozeni: String(row['Datum narození'] || '').match(/\d{4}/)?.[0] || appData.client.rok_narozeni,
        telefon: String(row['Telefon (nepovinné)'] || '').trim(),
        email: String(row['Email/Datová schránka'] || '').trim(),
        zamestnani_status: normalizeEmploymentStatus(row['Postavení na trhu práce']),
        hlavni_zdroj_prijmu: String(row['Dosažené vzdělání'] || '').trim(),
        zdravotni_socialni_omezeni: String(row['Znevýhodnění'] || '').trim(),
        poznamka_poradce: ''
      };
      touch();
      renderClientForm();
      renderSidebar();
      showToast();
    }

    function renderObligations() {
      const wrap = document.getElementById('obligationsWrap');
      const debt = debtSummary();
      const metrics = document.getElementById('obligationsSummaryMetrics');
      if (metrics) {
        metrics.innerHTML = [
          ['Počet dluhů', String(debt.pocet)],
          ['Celková výše', fmtCurrency(debt.celkem)],
          ['V exekuci', String(debt.v_exekuci)]
        ].map(([label, value]) => `
          <div class="metric">
            <div class="metric-label">${escapeHtml(label)}</div>
            <div class="metric-value">${escapeHtml(value)}</div>
          </div>
        `).join('');
      }
      if (!appData.obligations.length) {
        wrap.innerHTML = '<div class="muted">Zatím není vložen žádný závazek. Můžete použít AI asistent výše.</div>';
        return;
      }
      wrap.innerHTML = `
        <div class="simple-table-wrap">
          <table class="simple-table">
            <thead>
              <tr>
                <th>Věřitel</th>
                <th>Výše dluhu</th>
                <th>Datum vzniku dluhu</th>
                <th>Oblast dluhu</th>
                <th>Stav dluhu</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${appData.obligations.map((item, index) => `
                <tr>
                  <td class="col-wide"><input class="${!String(item.veritel_nazev || '').trim() ? 'input-invalid' : ''}" type="text" placeholder="Např. VZP" value="${escapeHtml(item.veritel_nazev || '')}" oninput="updateObligation(${index}, 'veritel_nazev', this.value)" /></td>
                  <td><input class="${safeNumber(item.vyse_dluhu) <= 0 ? 'input-invalid' : ''}" type="number" min="0" step="100" value="${safeNumber(item.vyse_dluhu)}" oninput="updateObligationNumber(${index}, 'vyse_dluhu', this.value)" /></td>
                  <td class="col-medium"><input type="text" placeholder="Např. 03/2025" value="${escapeHtml(item.datum_vzniku_dluhu || '')}" oninput="updateObligation(${index}, 'datum_vzniku_dluhu', this.value)" /></td>
                  <td class="col-medium"><select onchange="updateObligation(${index}, 'oblast_dluhu', this.value)">${selectOptions(OBLASTI_DLUHU, item.oblast_dluhu || 'další')}</select></td>
                  <td class="col-medium"><select onchange="updateObligation(${index}, 'stav_dluhu', this.value)">${selectOptions(STAVY_DLUHU_SIMPLE, item.stav_dluhu || 'ohrožena splatnost')}</select></td>
                  <td><button class="danger-link" type="button" onclick="removeObligation(${index})">Smazat</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    function renderIncome() {
      const wrap = document.getElementById('incomeWrap');
      if (!appData.budget.income_items.length) {
        wrap.innerHTML = '<div class="muted">Zatím není vložen žádný příjem.</div>';
        return;
      }
      wrap.innerHTML = appData.budget.income_items.map((item, index) => `
        <div class="item-card">
          <div class="item-head">
            <strong>${escapeHtml(item.typ || 'Nový příjem')}</strong>
            <button class="danger-link" type="button" onclick="removeIncome(${index})">Smazat</button>
          </div>
          <div class="item-grid-3">
            <div class="field"><label>Typ</label><select onchange="updateIncome(${index}, 'typ', this.value)">${selectOptions(PRIJEM_TYPY, item.typ || 'mzda')}</select></div>
            <div class="field"><label>Částka (Kč)</label><input type="number" min="0" step="100" value="${safeNumber(item.castka)}" oninput="updateIncomeNumber(${index}, 'castka', this.value)" /></div>
            <div class="field"><label>Pravidelnost</label><select onchange="updateIncome(${index}, 'pravidelnost', this.value)">${selectOptions(PRIJEM_PRAVIDELNOST, item.pravidelnost || 'mesicne')}</select></div>
          </div>
          <div class="field"><label>Komentář</label><input type="text" value="${escapeHtml(item.komentar || '')}" oninput="updateIncome(${index}, 'komentar', this.value)" /></div>
        </div>
      `).join('');
    }

    function renderExpense() {
      const wrap = document.getElementById('expenseWrap');
      if (!appData.budget.expense_items.length) {
        wrap.innerHTML = '<div class="muted">Zatím není vložen žádný výdaj.</div>';
        return;
      }
      wrap.innerHTML = appData.budget.expense_items.map((item, index) => `
        <div class="item-card">
          <div class="item-head">
            <strong>${escapeHtml(item.typ || 'Nový výdaj')}</strong>
            <button class="danger-link" type="button" onclick="removeExpense(${index})">Smazat</button>
          </div>
          <div class="item-grid-3">
            <div class="field"><label>Typ</label><select onchange="updateExpense(${index}, 'typ', this.value)">${selectOptions(VYDAJ_TYPY, item.typ || 'najem')}</select></div>
            <div class="field"><label>Částka (Kč)</label><input type="number" min="0" step="100" value="${safeNumber(item.castka)}" oninput="updateExpenseNumber(${index}, 'castka', this.value)" /></div>
            <div class="field"><label>Nezbytnost</label><select onchange="updateExpense(${index}, 'nezbytnost', this.value)">${selectOptions(NEZBYTNOST, item.nezbytnost || 'nezbytne')}</select></div>
          </div>
          <div class="field"><label>Komentář</label><input type="text" value="${escapeHtml(item.komentar || '')}" oninput="updateExpense(${index}, 'komentar', this.value)" /></div>
        </div>
      `).join('');
    }

    function renderCauses() {
      const freeText = document.getElementById('causes_free_text');
      const contextText = document.getElementById('causes_context_text');
      if (freeText) freeText.value = appData.mapping_summary.causes_free_text || '';
      if (contextText) contextText.value = appData.mapping_summary.causes_context_text || '';
    }

    function renderBudgetSummary() {
      calculateBudgetSummary();
      const summary = appData.budget.summary;
      document.getElementById('budgetSummaryMetrics').innerHTML = [
        ['Příjmy', fmtCurrency(summary.celkem_prijmy)],
        ['Výdaje bez splátek', fmtCurrency(summary.celkem_vydaje_bez_splatek)],
        ['Výdaje celkem', fmtCurrency(summary.celkem_vydaje_vcetne_splatek)],
        ['Volné prostředky', fmtCurrency(summary.volne_prostredky)]
      ].map(([label, value]) => `
        <div class="metric">
          <div class="metric-label">${escapeHtml(label)}</div>
          <div class="metric-value ${label === 'Volné prostředky' ? (summary.volne_prostredky < 0 ? 'danger' : 'success') : ''}">${escapeHtml(value)}</div>
        </div>
      `).join('');
    }

    function renderMappingSummary() {
      const nextSteps = document.getElementById('report_next_steps');
      const missingDocs = document.getElementById('report_missing_docs');
      const editor = document.getElementById('report_edited_text');
      if (nextSteps) nextSteps.value = appData.mapping_summary.report_next_steps || '';
      if (missingDocs) missingDocs.value = appData.mapping_summary.missing_docs_text || '';
      if (editor) editor.value = appData.report.edited_text || appData.report.generated_text || '';
      renderReportValidationBox();
    }

    function collectMappingSummaryFromForm() {
      const nextSteps = document.getElementById('report_next_steps');
      const missingDocs = document.getElementById('report_missing_docs');
      const causesText = document.getElementById('causes_free_text');
      const causesContextText = document.getElementById('causes_context_text');
      return {
        ...appData.mapping_summary,
        causes_free_text: causesText ? causesText.value.trim() : (appData.mapping_summary.causes_free_text || ''),
        causes_context_text: causesContextText ? causesContextText.value.trim() : (appData.mapping_summary.causes_context_text || ''),
        report_next_steps: nextSteps ? nextSteps.value.trim() : (appData.mapping_summary.report_next_steps || ''),
        missing_docs_text: missingDocs ? missingDocs.value.trim() : (appData.mapping_summary.missing_docs_text || '')
      };
    }

    function saveMappingSummaryNow() {
      appData.mapping_summary = collectMappingSummaryFromForm();
      touch();
    }

    const saveMappingSummaryDebounced = debounce(() => {
      appData.mapping_summary = collectMappingSummaryFromForm();
      touch();
    }, 800);

    function getValidationIssues() {
      const issues = [];
      if (!String(appData.client?.jmeno_klienta || '').trim()) issues.push('Doplňte jméno klienta.');
      if (!Array.isArray(appData.obligations) || !appData.obligations.length) issues.push('Doplňte alespoň jeden závazek.');
      (appData.obligations || []).forEach((item, index) => {
        if (!String(item.veritel_nazev || '').trim()) issues.push(`Závazek ${index + 1}: chybí věřitel.`);
        if (safeNumber(item.vyse_dluhu) <= 0) issues.push(`Závazek ${index + 1}: výše dluhu musí být větší než 0 Kč.`);
      });
      return issues;
    }

    function renderReportValidationBox() {
      const box = document.getElementById('reportValidationBox');
      if (!box) return;
      const issues = getValidationIssues();
      if (!issues.length) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
      }
      box.classList.remove('hidden');
      box.innerHTML = `<strong>Před návrhem zprávy ještě chybí:</strong><br>${issues.map(item => `- ${escapeHtml(item)}`).join('<br>')}`;
    }

    function ensureReadyForReport() {
      saveMappingSummaryNow();
      const issues = getValidationIssues();
      renderReportValidationBox();
      if (!issues.length) return true;
      currentView = 'report';
      openView('report');
      alert(`Před vytvořením zprávy je potřeba doplnit:\n\n${issues.join('\n')}`);
      return false;
    }

    function buildGeneratedReport() {
      syncObligationTotals();
      calculateBudgetSummary();
      const debt = debtSummary();
      const client = appData.client;

      const obligationLines = appData.obligations.length
        ? appData.obligations.map(item => `- ${item.veritel_nazev || 'Neuvedeno'} | výše: ${fmtCurrency(item.vyse_dluhu)} | stav: ${item.stav_dluhu || 'ohrožena splatnost'}`)
        : ['- Závazky zatím nejsou vyplněny.'];

      const causeLines = appData.mapping_summary.causes_free_text ? appData.mapping_summary.causes_free_text.split('\n').map(line => line.trim()).filter(Boolean) : ['Neuvedeno.'];
      const contextLines = appData.mapping_summary.causes_context_text ? appData.mapping_summary.causes_context_text.split('\n').map(line => line.trim()).filter(Boolean) : ['Neuvedeno.'];
      const missingDocLines = appData.mapping_summary.missing_docs_text ? appData.mapping_summary.missing_docs_text.split('\n').map(line => line.trim()).filter(Boolean) : ['Neuvedeno.'];
      const nextStepLinesRaw = appData.mapping_summary.report_next_steps
        ? appData.mapping_summary.report_next_steps.split('\n').map(line => line.trim()).filter(Boolean)
        : [];
      const nextStepLines = nextStepLinesRaw.filter(line => !/mapov[aá]n|zmapovat|dal[sš][ií]\s+mapov[aá]n/i.test(line));
      const finalNextStepLines = nextStepLines.length ? nextStepLines : ['Neuvedeno.'];

      const lines = [
        `ZPRÁVA Z MAPOVÁNÍ PŘEDLUŽENÍ – ${client.jmeno_klienta || 'bez jména'}`,
        '',
        '1. Klient',
        `Věk: ${calculateAge(client.rok_narozeni)}`,
        `Zaměstnání: ${client.zamestnani_status || 'neuvedeno'}`,
        `Poznámka poradce: ${client.poznamka_poradce || 'neuvedeno'}`,
        '',
        '2. Závazky',
        `Počet dluhů: ${debt.pocet} | celková výše: ${fmtCurrency(debt.celkem)} | v exekuci: ${debt.v_exekuci}.`,
        ...obligationLines,
        '',
        '3. Příčiny předlužení',
        ...causeLines,
        '',
        '4. Další kontextové informace',
        ...contextLines,
        '',
        '5. Chybějící podklady',
        ...missingDocLines.map(item => `- ${item}`),
        '',
        '6. Další doporučené kroky',
        ...finalNextStepLines.map(item => `- ${item}`)
      ];
      return lines.join('\n');
    }

    function generateReport() {
      if (!ensureReadyForReport()) return;
      const generated = buildGeneratedReport();
      appData.report.generated_text = generated;
      appData.report.edited_text = generated;
      touch();
      renderMappingSummary();
      alert('Klasický návrh zprávy (odrážky) byl vygenerován.');
    }

    const saveReportTextDebounced = debounce(() => {
      appData.report.edited_text = document.getElementById('report_edited_text').value;
      touch();
    }, 800);

    function currentReportText() {
      const edited = document.getElementById('report_edited_text').value.trim();
      return edited ? edited : (appData.report.generated_text || '');
    }

    function sanitizeReportExportText(text) {
      return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\*/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
    }

    function reportTextToWordHtml(text) {
      const lines = sanitizeReportExportText(text).split('\n');
      const blocks = [];
      let bulletItems = [];

      function flushBullets() {
        if (!bulletItems.length) return;
        blocks.push(`<ul style="margin: 0 0 14px 22px; padding: 0;">${bulletItems.join('')}</ul>`);
        bulletItems = [];
      }

      lines.forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (!line) {
          flushBullets();
          return;
        }

        if (index === 0) {
          flushBullets();
          blocks.push(`<h1 style="font-family: Calibri, Arial, sans-serif; font-size: 20pt; margin: 0 0 18px; color: #1f2937;">${escapeHtml(line)}</h1>`);
          return;
        }

        if (/^\d+\.\s+/.test(line)) {
          flushBullets();
          blocks.push(`<h2 style="font-family: Calibri, Arial, sans-serif; font-size: 13.5pt; margin: 18px 0 8px; color: #1f2937;">${escapeHtml(line)}</h2>`);
          return;
        }

        if (/^- /.test(line)) {
          bulletItems.push(`<li style="margin: 0 0 6px;">${escapeHtml(line.replace(/^- /, ''))}</li>`);
          return;
        }

        flushBullets();
        blocks.push(`<p style="margin: 0 0 12px; line-height: 1.55;">${escapeHtml(line)}</p>`);
      });

      flushBullets();
      return blocks.join('');
    }

    function addObligation() {
      appData.obligations.push({
        id: '', veritel_nazev: '', vyse_dluhu: 0, datum_vzniku_dluhu: '', oblast_dluhu: 'další', stav_dluhu: 'ohrožena splatnost'
      });
      saveCollectionsAndRefresh();
    }

    function removeObligation(index) { appData.obligations.splice(index, 1); saveCollectionsAndRefresh(); renderReportValidationBox(); }
    function updateObligation(index, key, value) { appData.obligations[index][key] = value; touch(); renderObligations(); renderReportValidationBox(); }
    function updateObligationNumber(index, key, value) { appData.obligations[index][key] = safeNumber(value); touch(); renderObligations(); renderBudgetSummary(); renderReportValidationBox(); }

    function addIncome() { appData.budget.income_items.push({ id: '', typ: 'mzda', castka: 0, pravidelnost: 'mesicne', komentar: '' }); saveCollectionsAndRefresh(); }
    function removeIncome(index) { appData.budget.income_items.splice(index, 1); saveCollectionsAndRefresh(); }
    function updateIncome(index, key, value) { appData.budget.income_items[index][key] = value; touch(); }
    function updateIncomeNumber(index, key, value) { appData.budget.income_items[index][key] = safeNumber(value); touch(); renderBudgetSummary(); }

    function addExpense() { appData.budget.expense_items.push({ id: '', typ: 'najem', castka: 0, nezbytnost: 'nezbytne', komentar: '' }); saveCollectionsAndRefresh(); }
    function removeExpense(index) { appData.budget.expense_items.splice(index, 1); saveCollectionsAndRefresh(); }
    function updateExpense(index, key, value) { appData.budget.expense_items[index][key] = value; touch(); }
    function updateExpenseNumber(index, key, value) { appData.budget.expense_items[index][key] = safeNumber(value); touch(); renderBudgetSummary(); }

    function downloadBlob(filename, content, type) {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function exportReportWord() {
      const content = currentReportText();
      if (!content) { alert('Zpráva je zatím prázdná.'); return; }

      const preHtml = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>Zpráva</title></head><body>";
      const postHtml = "</body></html>";
      const htmlContent = escapeHtml(content).replace(/\n/g, '<br>');
      const html = preHtml + "<div style='font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;'>" + htmlContent + "</div>" + postHtml;

      const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = reportFilename('doc');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function exportReportWord() {
      const content = currentReportText();
      if (!content) { alert('ZprĂˇva je zatĂ­m prĂˇzdnĂˇ.'); return; }

      const cleanContent = sanitizeReportExportText(content);
      const preHtml = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>ZprĂˇva</title><style>body{font-family:Calibri,Arial,sans-serif;color:#111827;font-size:11pt;margin:32px;} p,li{font-size:11pt;} ul{list-style-type:disc;}</style></head><body>";
      const postHtml = "</body></html>";
      const htmlContent = reportTextToWordHtml(cleanContent);
      const html = preHtml + htmlContent + postHtml;

      const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = reportFilename('doc');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function exportReportPdf() {
      const content = sanitizeReportExportText(currentReportText());
      if (!content) { alert('Zpráva je zatím prázdná.'); return; }
      const printDiv = document.createElement('div');
      printDiv.innerHTML = `<h1 style="font-family:Arial,sans-serif;font-size:22px;margin-bottom:20px;border-bottom:2px solid #000;padding-bottom:10px;">Zpráva z mapování předlužení</h1><div style="font-family:Arial,sans-serif;font-size:12px;line-height:1.65;white-space:pre-wrap;">${escapeHtml(content)}</div>`;
      html2pdf().set({ margin: 15, filename: reportFilename('pdf'), image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } }).from(printDiv).save();
    }

    function exportJson() {
      touch();
      downloadBlob(`mapovani.json`, JSON.stringify(appData, null, 2), 'application/json;charset=utf-8');
    }

    function renderAll() {
      if (!appData.client) appData = defaultCase();
      renderMenu();
      renderSidebar();
      renderClientForm();
      renderObligations();
      renderIncome();
      renderExpense();
      renderBudgetSection();
      renderBudgetSummary();
      renderCauses();
      renderMappingSummary();
      openView(currentView);
    }

    document.getElementById('saveJsonBtn').addEventListener('click', exportJson);
    document.getElementById('loadJsonInput').addEventListener('change', event => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          appData = normalizeAppData(JSON.parse(reader.result));
          renderAll();
          alert('JSON byl načten.');
        } catch (error) {
          alert('Soubor se nepodařilo načíst.');
        }
      };
      reader.readAsText(file, 'utf-8');
      event.target.value = '';
    });

    document.getElementById('resetCaseBtn').addEventListener('click', () => {
      if (confirm('Opravdu chcete vymazat data a začít nové prázdné mapování?')) {
        localStorage.removeItem('auditDataBackupV4');
        appData = defaultCase();
        renderAll();
      }
    });

    const savedLocal = localStorage.getItem('auditDataBackupV4');
    if (savedLocal) {
      try { appData = normalizeAppData(JSON.parse(savedLocal)); } catch (e) {}
    }

    renderAll();
    loadClientRegistry();
  
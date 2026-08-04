// Ticket prices
const TICKET_PRICES = {
  adults: 5.45,
  child: 4.35,
  free: 0,
  group: 4.35
};

// State
let latestData = null;
let selectedRow = null;

// DOM Elements
const selectDate = document.getElementById('select-date');
const fileInput = document.getElementById('file-input');
const filePrompt = document.getElementById('file-name');
const dropzone = document.getElementById('dropzone');
const previewContainer = document.getElementById('preview-container');
const imagePreview = document.getElementById('image-preview');
const btnRemoveImage = document.getElementById('btn-remove-image');
const btnProcess = document.getElementById('btn-process');
const loadingOverlay = document.getElementById('loading-overlay');
const reviewSection = document.getElementById('review-section');

// Form inputs
const inputAdultsDel = document.getElementById('adultos_del');
const inputAdultsAl = document.getElementById('adultos_al');
const inputInfantilDel = document.getElementById('infantil_del');
const inputInfantilAl = document.getElementById('infantil_al');
const inputGratuitoDel = document.getElementById('gratuito_del');
const inputGratuitoAl = document.getElementById('gratuito_al');
const inputGruposDel = document.getElementById('grupos_del');
const inputGruposAl = document.getElementById('grupos_al');
const inputRecaudacion = document.getElementById('recaudacion');

// Calculation displays
const qtyAdults = document.getElementById('calc_adultos_qty');
const totalAdults = document.getElementById('calc_adultos_total');
const qtyInfantil = document.getElementById('calc_infantil_qty');
const totalInfantil = document.getElementById('calc_infantil_total');
const qtyGratuito = document.getElementById('calc_gratuito_qty');
const qtyGrupos = document.getElementById('calc_grupos_qty');
const totalGrupos = document.getElementById('calc_grupos_total');
const displayFacReal = document.getElementById('calc_fac_real');
const discrepancyBanner = document.getElementById('discrepancy-banner');
const discrepancyText = document.getElementById('discrepancy-text');

// Settings modal
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const btnCloseSettings = document.getElementById('btn-close-settings');
const inputApiKey = document.getElementById('input-api-key');
const inputScriptUrl = document.getElementById('input-script-url');
const btnSaveSettings = document.getElementById('btn-save-settings');

// Initialize Settings from localStorage
let geminiApiKey = localStorage.getItem('gemini_api_key') || '';
let googleScriptUrl = localStorage.getItem('google_script_url') || 'https://script.google.com/macros/s/AKfycbyfhQ3yTv9XCClDi8fEkQC1gvdnqezKgHWmxFaNBh9wwePEXCKaNDvNmhU_2q1kEYhJ/exec';

inputApiKey.value = geminiApiKey;
inputScriptUrl.value = googleScriptUrl;

// Load Excel dates on startup
async function fetchLatestData() {
  if (!googleScriptUrl) {
    selectDate.innerHTML = '<option disabled selected>Configura la URL de Google Script...</option>';
    return;
  }

  try {
    const res = await fetch(googleScriptUrl);
    if (!res.ok) throw new Error('Error al cargar datos de Google Sheets');
    latestData = await res.json();
    
    // Clear select date
    selectDate.innerHTML = '';
    
    // Fill select date
    latestData.rows.forEach(row => {
      let displayDate = row.dateStr;
      if (displayDate && (displayDate.includes('GMT') || displayDate.length > 10)) {
        try {
          const d = new Date(displayDate);
          if (!isNaN(d.getTime())) {
            const offset = d.getTimezoneOffset();
            const adjustedDate = new Date(d.getTime() - (offset * 60 * 1000));
            displayDate = adjustedDate.toISOString().split('T')[0];
          }
        } catch(e) {}
      }
      const option = document.createElement('option');
      option.value = row.dateSerial;
      option.textContent = `${displayDate} ${row.isFilled ? '✓ (Guardado)' : '⚠ (Pendiente)'}`;
      selectDate.appendChild(option);
    });

    // Select the next row to fill by default
    if (latestData.nextRowToFill) {
      selectDate.value = latestData.nextRowToFill.dateSerial;
      updateSelectedRow(latestData.nextRowToFill.dateSerial);
    }

    // Render the audit table log
    renderAuditTable();
  } catch (err) {
    alert(err.message);
  }
}

function updateSelectedRow(serial) {
  if (!latestData || !latestData.rows) return;
  const row = latestData.rows.find(r => r.dateSerial == serial);
  if (!row) return;
  selectedRow = row;

  // Pre-fill Del numbers
  inputAdultsDel.value = row.adultosDel;
  inputInfantilDel.value = row.infantilDel;
  inputGratuitoDel.value = row.gratuitoDel;
  inputGruposDel.value = row.gruposDel;

  // If already filled, populate the AL numbers as well
  inputAdultsAl.value = row.adultosAl;
  inputInfantilAl.value = row.infantilAl;
  inputGratuitoAl.value = row.gratuitoAl;
  inputGruposAl.value = row.gruposAl;
  inputRecaudacion.value = row.recaudacion;

  // Update calculations
  recalculateAll();
}

// Handle date selection change
selectDate.addEventListener('change', (e) => {
  updateSelectedRow(e.target.value);
});

// Recalculate passenger quantities, prices and discrepancies
function recalculateAll() {
  const aDel = parseInt(inputAdultsDel.value) || 0;
  const aAl = parseInt(inputAdultsAl.value) || 0;
  const iDel = parseInt(inputInfantilDel.value) || 0;
  const iAl = parseInt(inputInfantilAl.value) || 0;
  const gDel = parseInt(inputGratuitoDel.value) || 0;
  const gAl = parseInt(inputGratuitoAl.value) || 0;
  const grDel = parseInt(inputGruposDel.value) || 0;
  const grAl = parseInt(inputGruposAl.value) || 0;
  const rec = parseFloat(inputRecaudacion.value) || 0.0;

  // Quantities
  const aQty = Math.max(0, aAl - aDel);
  const iQty = Math.max(0, iAl - iDel);
  const gQty = Math.max(0, gAl - gDel);
  const grQty = Math.max(0, grAl - grDel);

  // Subtotals
  const aSub = aQty * TICKET_PRICES.adults;
  const iSub = iQty * TICKET_PRICES.child;
  const grSub = grQty * TICKET_PRICES.group;
  const facReal = aSub + iSub + grSub;

  // Update UI texts
  qtyAdults.textContent = aQty;
  totalAdults.textContent = `${aSub.toFixed(2)}€`;
  qtyInfantil.textContent = iQty;
  totalInfantil.textContent = `${iSub.toFixed(2)}€`;
  qtyGratuito.textContent = gQty;
  qtyGrupos.textContent = grQty;
  totalGrupos.textContent = `${grSub.toFixed(2)}€`;
  displayFacReal.textContent = `${facReal.toFixed(2)}€`;

  // Compare Recaudación vs Facturación
  const diff = Math.abs(rec - facReal);
  if (diff < 0.01) {
    discrepancyBanner.className = 'discrepancy-banner success';
    discrepancyText.textContent = 'Las cifras coinciden perfectamente.';
  } else {
    discrepancyBanner.className = 'discrepancy-banner danger';
    const operator = rec > facReal ? 'sobran' : 'faltan';
    discrepancyText.textContent = `Existe un descuadre de ${diff.toFixed(2)}€ (el datáfono marca ${rec.toFixed(2)}€, la venta calculada es ${facReal.toFixed(2)}€).`;
  }
}

// Add event listeners to input changes
document.querySelectorAll('.target-input').forEach(input => {
  input.addEventListener('input', recalculateAll);
});

// Image file selection & dropzone handling
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleSelectedImage(e.target.files[0]);
  }
});

function handleSelectedImage(file) {
  filePrompt.textContent = file.name;
  
  // Show preview
  const reader = new FileReader();
  reader.onload = (e) => {
    imagePreview.src = e.target.result;
    previewContainer.style.display = 'block';
    dropzone.style.display = 'none';
    btnProcess.disabled = false;
  };
  reader.readAsDataURL(file);
}

btnRemoveImage.addEventListener('click', () => {
  fileInput.value = '';
  filePrompt.textContent = 'Ningún archivo seleccionado';
  previewContainer.style.display = 'none';
  dropzone.style.display = 'block';
  btnProcess.disabled = true;
});

// Upload and analyze image with Gemini
btnProcess.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  // Validate API Key
  if (!geminiApiKey) {
    alert('Por favor, introduce tu Gemini API Key en el menú de configuración (esquina superior derecha).');
    settingsModal.style.display = 'flex';
    return;
  }

  // Show processing
  loadingOverlay.style.display = 'flex';
  reviewSection.style.display = 'none';

  try {
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const base64Data = event.target.result.split(',')[1];
        const mimeType = file.type;

        const prompt = `Analiza la imagen que contiene talonarios de boletos de tren turístico y una pantalla o ticket de datáfono (pago con tarjeta).
Extrae los siguientes datos:
1. De los talonarios de boletos (busca el número en el boleto de la derecha de cada pila, que es el último número vendido hoy):
   - Boletos Blancos (Adultos/General): busca un número de 5 dígitos (ej. 04423).
   - Boletos Amarillos (Infantil): busca un número de 5 dígitos (ej. 00020).
   - Boletos Verdes (Infantil Gratuito / Sin ocupar asiento): busca un número de 5 dígitos (ej. 00026).
   - Boletos Azules (Grupos de más de 10): busca un número de 5 dígitos (ej. 00022).
2. De la pantalla del datáfono o ticket impreso:
   - El 'Importe Total' o ventas totales (ej. 641.85).

Devuelve únicamente un objeto JSON con el siguiente formato, sin bloques de código markdown ni texto adicional:
{
  "adultos_al": 4423,
  "infantil_al": 20,
  "gratuito_al": 26,
  "grupos_al": 22,
  "recaudacion": 641.85
}
Si no encuentras alguno de los valores, pon null.`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType: mimeType,
                      data: base64Data
                    }
                  }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: "application/json"
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Error de la API de Gemini: ${errorText}`);
        }

        const data = await response.json();
        const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResult) {
          throw new Error('Gemini devolvió una respuesta vacía');
        }

        const cleanedResult = textResult.trim().replace(/^```json/, '').replace(/```$/, '');
        const result = JSON.parse(cleanedResult);

        // Fill extracted data
        if (result.adultos_al !== null) inputAdultsAl.value = result.adultos_al;
        if (result.infantil_al !== null) inputInfantilAl.value = result.infantil_al;
        if (result.gratuito_al !== null) inputGratuitoAl.value = result.gratuito_al;
        if (result.grupos_al !== null) inputGruposAl.value = result.grupos_al;
        if (result.recaudacion !== null) inputRecaudacion.value = result.recaudacion;

        recalculateAll();
        reviewSection.style.display = 'block';
        reviewSection.scrollIntoView({ behavior: 'smooth' });
      } catch (err) {
        alert('Error de análisis de IA: ' + err.message);
      } finally {
        loadingOverlay.style.display = 'none';
      }
    };
    reader.readAsDataURL(file);
  } catch (err) {
    alert(err.message);
    loadingOverlay.style.display = 'none';
  }
});

// Submit/Save to Excel
document.getElementById('review-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  if (!selectedRow) return;

  const payload = {
    rowIdx: selectedRow.rowIdx,
    adultos_al: parseInt(inputAdultsAl.value),
    infantil_al: parseInt(inputInfantilAl.value),
    gratuito_al: parseInt(inputGratuitoAl.value),
    grupos_al: parseInt(inputGruposAl.value),
    recaudacion: parseFloat(inputRecaudacion.value)
  };

  try {
    const res = await fetch(googleScriptUrl, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error('Error al guardar en Google Sheets');
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    alert('¡Datos guardados con éxito en Google Sheets!');
    
    // Refresh dates lists
    await fetchLatestData();
  } catch (err) {
    alert(err.message);
  }
});

// Settings Modal interactions
btnSettings.addEventListener('click', () => {
  settingsModal.style.display = 'flex';
});

btnCloseSettings.addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

btnSaveSettings.addEventListener('click', () => {
  geminiApiKey = inputApiKey.value.trim();
  googleScriptUrl = inputScriptUrl.value.trim();
  localStorage.setItem('gemini_api_key', geminiApiKey);
  localStorage.setItem('google_script_url', googleScriptUrl);
  settingsModal.style.display = 'none';
  alert('Configuración guardada correctamente.');
  fetchLatestData();
});

// Drag and drop handling
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = 'var(--accent-color)';
});

dropzone.addEventListener('dragleave', () => {
  dropzone.style.borderColor = 'var(--border-color)';
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = 'var(--border-color)';
  if (e.dataTransfer.files.length > 0) {
    fileInput.files = e.dataTransfer.files;
    handleSelectedImage(e.dataTransfer.files[0]);
  }
});

const auditTableBody = document.getElementById('audit-table-body');
const btnRefreshAudit = document.getElementById('btn-refresh-audit');

function renderAuditTable() {
  if (!latestData || !latestData.rows) return;

  // Filter filled rows and reverse to show most recent first
  const filledRows = latestData.rows.filter(r => r.isFilled).reverse().slice(0, 10);

  if (filledRows.length === 0) {
    auditTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center">No hay cierres registrados todavía.</td>
      </tr>
    `;
    return;
  }

  auditTableBody.innerHTML = '';
  filledRows.forEach(row => {
    // Recalculate fields dynamically
    const aQty = Math.max(0, (row.adultosAl || 0) - (row.adultosDel || 0));
    const iQty = Math.max(0, (row.infantilAl || 0) - (row.infantilDel || 0));
    const gQty = Math.max(0, (row.gratuitoAl || 0) - (row.gratuitoDel || 0));
    const grQty = Math.max(0, (row.gruposAl || 0) - (row.gruposDel || 0));

    const aSub = aQty * TICKET_PRICES.adults;
    const iSub = iQty * TICKET_PRICES.child;
    const grSub = grQty * TICKET_PRICES.group;
    const facReal = aSub + iSub + grSub;
    const recVal = parseFloat(row.recaudacion) || 0.0;

    // Check discrepancy
    const diff = Math.abs(recVal - facReal);
    let statusHtml = '';
    if (diff < 0.01) {
      statusHtml = `<span class="audit-badge success"><i class="bi bi-check-circle-fill"></i> Cuadrado</span>`;
    } else {
      statusHtml = `<span class="audit-badge warning"><i class="bi bi-exclamation-triangle-fill"></i> Descuadre (${(recVal - facReal) > 0 ? '+' : ''}${(recVal - facReal).toFixed(2)}€)</span>`;
    }

    // Format date string
    let displayDate = row.dateStr;
    if (displayDate && (displayDate.includes('GMT') || displayDate.length > 10)) {
      try {
        const d = new Date(displayDate);
        if (!isNaN(d.getTime())) {
          const offset = d.getTimezoneOffset();
          const adjustedDate = new Date(d.getTime() - (offset * 60 * 1000));
          displayDate = adjustedDate.toISOString().split('T')[0];
        }
      } catch(e) {}
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${displayDate}</strong></td>
      <td>${row.adultosAl} <span class="text-secondary" style="font-size:0.8rem">(${row.adultosDel} a ${row.adultosAl})</span></td>
      <td>${row.infantilAl} <span class="text-secondary" style="font-size:0.8rem">(${row.infantilDel} a ${row.infantilAl})</span></td>
      <td>${row.gratuitoAl} <span class="text-secondary" style="font-size:0.8rem">(${row.gratuitoDel} a ${row.gratuitoAl})</span></td>
      <td>${row.gruposAl} <span class="text-secondary" style="font-size:0.8rem">(${row.gruposDel} a ${row.gruposAl})</span></td>
      <td><strong>${recVal.toFixed(2)}€</strong></td>
      <td>${statusHtml}</td>
    `;
    auditTableBody.appendChild(tr);
  });
}

btnRefreshAudit.addEventListener('click', fetchLatestData);

// Fetch data on load
fetchLatestData();

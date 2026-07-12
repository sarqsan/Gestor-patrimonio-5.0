import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import * as XLSX from "xlsx";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lazy initialization of the Gemini API Client
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("La clave GEMINI_API_KEY no está configurada. Por favor, añádela en la sección de Secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Helper to clean up any markdown wraps in JSON output returned by Gemini
function cleanJsonText(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return cleaned;
}

function parseAnyNumber(val: any): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") {
    return isNaN(val) ? 0 : val;
  }
  let str = String(val).trim().replace(/[€\s\$%a-zA-Z]/g, "");
  if (!str) return 0;
  
  // If there is both a dot and a comma, like "36.200,50"
  if (str.includes(".") && str.includes(",")) {
    // Dot is thousands, comma is decimal
    str = str.replace(/\./g, "").replace(/,/g, ".");
  } else if (str.includes(",")) {
    // Only comma, e.g. "36200,50" -> comma is decimal
    str = str.replace(/,/g, ".");
  } else if (str.includes(".")) {
    // Only dot, e.g. "36.200" or "36200.50"
    // If there is a dot followed by exactly 3 digits at the end, it is likely a thousands separator (e.g. "36.200")
    // Unless there are multiple dots, in which case they are definitely thousands separators (e.g. "1.250.000")
    const parts = str.split(".");
    if (parts.length > 2) {
      // Multiple dots: "1.250.000" -> thousands separators
      str = str.replace(/\./g, "");
    } else {
      // Single dot: e.g. "36.200" vs "36200.50"
      const decimalPart = parts[1];
      if (decimalPart.length === 3) {
        // E.g. "36.200" is thousands separator
        const parsedWithoutDot = parseFloat(str.replace(/\./g, ""));
        const parsedWithDot = parseFloat(str);
        if (parsedWithoutDot >= 100 && parsedWithDot < 10) {
          str = str.replace(/\./g, "");
        }
      }
    }
  }
  
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

function cleanNameString(name: string, fallbackDefault: string): string {
  if (!name) return fallbackDefault;
  
  let clean = name.trim();
  
  // If the name is in "LASTNAMES, FIRSTNAME" format, convert to "FIRSTNAME LASTNAMES"
  if (clean.includes(",") && (clean.split(",").length === 2)) {
    const parts = clean.split(",");
    const lastNames = parts[0].trim();
    const firstName = parts[1].trim();
    if (lastNames && firstName) {
      clean = `${firstName} ${lastNames}`;
    }
  }
  
  // Strip trailing punctuation/spaces using a foolproof char-by-char check
  while (clean.length > 0 && /[,;._\\\-\/\s\t\n\r]/.test(clean.charAt(clean.length - 1))) {
    clean = clean.substring(0, clean.length - 1);
  }
  
  // Strip leading punctuation/spaces
  while (clean.length > 0 && /[,;._\\\-\/\s\t\n\r]/.test(clean.charAt(0))) {
    clean = clean.substring(1);
  }
  
  // Replace multiple spaces or consecutive punctuation in the middle with a single space
  clean = clean.replace(/,+/g, " ");
  clean = clean.replace(/\s+/g, " ");
  clean = clean.trim();
  
  const upper = clean.toUpperCase();
  const genericLabels = [
    "CONYUGE DECLARANTE", "CONYUGE", "CÓNYUGE DECLARANTE", "CÓNYUGE",
    "DECLARANTE", "DECLARANTE PRINCIPAL", "SUJETO PASIVO", "SEGUNDO DECLARANTE",
    "PRIMER DECLARANTE", "TITULAR", "S. DE B.", "S.PASIVO", "SPASIVO",
    "USUARIO", "USUARIO 1", "USUARIO 2", "PROPIETARIO PRINCIPAL",
    "NO DETECTADO", "NO ESPECIFICADO", "NO APLICA", ""
  ];
  
  if (genericLabels.includes(upper) || upper.length < 2) {
    return fallbackDefault;
  }
  
  // Clean up casing if entirely uppercase to make it look highly polished and premium
  if (clean === upper) {
    clean = clean.toLowerCase().replace(/(?:^|\s)\S/g, (res) => res.toUpperCase());
  }
  
  return clean;
}

function cleanDniString(dni: string): string {
  if (!dni) return "";
  let clean = dni.trim().toUpperCase();
  // Remove prefix labels like NIF, DNI, NIE, CIF
  clean = clean.replace(/^(?:NIF|DNI|NIE|CIF)[:\-\s]*/, "");
  // Remove everything except letters and numbers
  clean = clean.replace(/[^A-Z0-9]/g, "");
  return clean;
}

function sanitizeExtractionResult(data: any): any {
  if (!data) return data;
  
  const sanitized = { ...data };
  
  if (sanitized.user1) {
    sanitized.user1 = {
      ...sanitized.user1,
      name: cleanNameString(sanitized.user1.name, "Usuario 1"),
      dni: cleanDniString(sanitized.user1.dni),
      brutoTrabajo: parseAnyNumber(sanitized.user1.brutoTrabajo),
      netoTrabajo: parseAnyNumber(sanitized.user1.netoTrabajo)
    };
  } else {
    sanitized.user1 = { name: "Usuario 1", dni: "", brutoTrabajo: 0, netoTrabajo: 0 };
  }
  
  if (sanitized.user2) {
    const hasPartnerValue = sanitized.user2.hasPartner !== undefined ? sanitized.user2.hasPartner : false;
    const cleanedName = cleanNameString(sanitized.user2.name, "Cónyuge");
    
    // If the spouse has a name that isn't the fallback, or has a valid DNI, or hasPartner is true
    const isSpouseActive = hasPartnerValue || (cleanedName !== "Cónyuge" && cleanedName !== "") || (sanitized.user2.dni && sanitized.user2.dni.trim() !== "");
    
    sanitized.user2 = {
      ...sanitized.user2,
      name: cleanedName,
      dni: cleanDniString(sanitized.user2.dni),
      brutoTrabajo: parseAnyNumber(sanitized.user2.brutoTrabajo),
      netoTrabajo: parseAnyNumber(sanitized.user2.netoTrabajo),
      hasPartner: isSpouseActive
    };
  } else {
    sanitized.user2 = { name: "Usuario 2", dni: "", brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false };
  }
  
  if (Array.isArray(sanitized.properties)) {
    sanitized.properties = sanitized.properties.map((prop: any) => {
      if (!prop) return prop;
      const cleanProp = { ...prop };
      
      if (cleanProp.address) {
        cleanProp.address = cleanProp.address.replace(/^[,;.\s\\\-\/]+/, "").replace(/[,;.\s\\\-\/]+$/, "").trim();
      }
      
      if (cleanProp.cadastralReference) {
        cleanProp.cadastralReference = cleanProp.cadastralReference.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      }
      
      if (cleanProp.tenantName) {
        cleanProp.tenantName = cleanProp.tenantName.replace(/^[,;.\s\\\-\/]+/, "").replace(/[,;.\s\\\-\/]+$/, "").trim();
        cleanProp.tenantName = cleanProp.tenantName.replace(/,+/g, ", ").replace(/\s+/g, " ").trim();
      }
      
      if (cleanProp.tenantDni) {
        cleanProp.tenantDni = cleanProp.tenantDni.trim().toUpperCase().replace(/[^A-Z0-9,\s]/g, "");
        cleanProp.tenantDni = cleanProp.tenantDni.replace(/,+/g, ", ").replace(/\s+/g, " ").trim();
      }
      
      // Parse all numeric fields
      cleanProp.ownershipPercentageUser1 = parseAnyNumber(cleanProp.ownershipPercentageUser1);
      cleanProp.ownershipPercentageUser2 = parseAnyNumber(cleanProp.ownershipPercentageUser2);
      cleanProp.monthlyRent = parseAnyNumber(cleanProp.monthlyRent);
      cleanProp.purchasePrice = parseAnyNumber(cleanProp.purchasePrice);
      cleanProp.landValuePercent = parseAnyNumber(cleanProp.landValuePercent) || 25;
      cleanProp.amortizationAmount = parseAnyNumber(cleanProp.amortizationAmount);
      cleanProp.expensesCommunity = parseAnyNumber(cleanProp.expensesCommunity);
      cleanProp.expensesIBI = parseAnyNumber(cleanProp.expensesIBI);
      cleanProp.expensesInsurance = parseAnyNumber(cleanProp.expensesInsurance);
      cleanProp.expensesRepairs = parseAnyNumber(cleanProp.expensesRepairs);
      
      return cleanProp;
    });
  }
  
  return sanitized;
}

// Robust retry helper with exponential backoff and model fallback to handle 503 high demand
async function generateContentWithRetry(
  contents: any,
  config: any,
  initialModel: string = "gemini-3.5-flash"
): Promise<any> {
  const modelsToTry = [initialModel, "gemini-3.5-flash"];
  let lastError: any = null;

  // Format contents to wrap a bare list of Parts into a compliant Content object with a parts array
  let formattedContents = contents;
  if (Array.isArray(contents)) {
    const isBarePartArray = contents.every(item => 
      item && (item.text !== undefined || item.inlineData !== undefined || item.functionCall !== undefined || item.functionResponse !== undefined)
    );
    if (isBarePartArray) {
      formattedContents = { parts: contents };
    }
  }

  for (const modelName of modelsToTry) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Gemini API] Attempting generateContent with ${modelName} (attempt ${attempt}/${maxRetries})...`);
        const ai = getGeminiClient();
        const response = await ai.models.generateContent({
          model: modelName,
          contents: formattedContents,
          config,
        });
        console.log(`[Gemini API] Success using model ${modelName} on attempt ${attempt}`);
        return response;
      } catch (err: any) {
        lastError = err;
        console.warn(`[Gemini API] Error with ${modelName} on attempt ${attempt}:`, err.message || err);
        
        // Wait with exponential backoff before next attempt within the same model
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 800 + Math.random() * 400;
          console.log(`[Gemini API] Retrying in ${delay.toFixed(0)}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    console.log(`[Gemini API] Model ${modelName} failed all ${maxRetries} attempts. Trying fallback model if available...`);
  }

  throw lastError || new Error("No se pudo conectar con los modelos de IA de Gemini tras varios intentos.");
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware for JSON payloads
  app.use(express.json({ limit: "10mb" }));

  // API Route: Extract tax declaration details using Gemini 3.5 Flash
  app.post("/api/extract", async (req, res) => {
    try {
      const { 
        text1, fileData1, mimeType1, 
        text2, fileData2, mimeType2,
        propertiesFileData, propertiesFileMime, propertiesFileName 
      } = req.body;
      
      if (!text1 && (!fileData1 || !mimeType1) && !text2 && (!fileData2 || !mimeType2) && (!propertiesFileData || !propertiesFileMime)) {
        res.status(400).json({ error: "Debe proporcionar al menos un documento: Declaración 1, Declaración 2 o Listado de Inmuebles." });
        return;
      }

      const systemPrompt = `Eres un experto fiscal de la Agencia Tributaria Española (AEAT).
Tu tarea es analizar la declaración de la renta de España (IRPF, Modelo 100, Borrador, Resumen de la Declaración o Datos Fiscales) y/o el documento de listado de inmuebles adjunto (Excel, CSV o PDF) de uno o dos contribuyentes (pareja/cónyuges) y extraer con precisión de cirujano la información sobre sus rentas del trabajo y sus inmuebles arrendados.

Sigue rigurosamente estas pautas para una extracción 100% precisa y libre de alucinaciones:

1. IDENTIFICACIÓN DE LOS CONTRIBUYENTES (USER 1 / USER 2):
   - Extrae SIEMPRE con total prioridad el nombre y DNI del Declarante Principal (que irá en 'user1') y del Cónyuge (que irá en 'user2').
   - El primer declarante, sujeto pasivo o titular que aparezca es 'user1'. El cónyuge o segundo declarante es 'user2'.
   - Si no hay cónyuge ni segundo declarante, establece 'hasPartner': false.
   - Limpia de forma absoluta cualquier ruido del nombre (como comas, puntos, guiones, barras, códigos o textos como 'DECLARANTE', 'CONYUGE'). El nombre debe ser un nombre natural (ej. 'YOLANDA SANCHEZ GOMEZ' o 'Yolanda Sánchez Gómez').
   - El DNI/NIF debe tener sus 8 dígitos y la letra (ej. '12345678Z' o 'X1234567Y' para NIE). Si contiene "NIF" o "DNI" delante, quítalo.

2. RENDIMIENTOS DEL TRABAJO (Sueldos y salarios):
   - Busca tanto en el 'Resumen de la declaración' (la tabla resumen con columnas 'Declarante', 'Cónyuge' y 'Conjunta') como en la sección detallada 'Rendimientos del trabajo'.
   - Ingresos brutos ('brutoTrabajo'): 
     * En la sección detallada, es la casilla 0012 ('Suma de rendimientos íntegros') o casilla 0003 ('Retribuciones en dinero').
     * En la tabla de 'Resumen de la declaración', es la fila 'Rendimientos del trabajo' o 'Rendimientos íntegros del trabajo'.
     * Extrae el valor correspondiente a la columna del declarante para 'user1' y del cónyuge para 'user2'. ¡No uses el de la columna conjunta!
   - Rendimiento neto ('netoTrabajo'):
     * En la sección detallada, es la casilla 0022 ('Rendimiento neto reducido') o casilla 0018 ('Rendimiento neto del trabajo').
     * En el 'Resumen de la declaración', es la fila 'Rendimiento neto' o 'Rendimiento neto reducido del trabajo'.

3. RENDIMIENTOS DEL CAPITAL INMOBILIARIO Y LISTADO DE INMUEBLES:
   - IMPORTANTE: Si se adjunta un Listado de Inmuebles (Documento 3 en Excel, CSV o PDF), este listado es la fuente de verdad primaria para la lista de inmuebles, sus direcciones, referencias catastrales, alquileres mensuales y precios de compra.
   - Si solo hay Declaraciones de Renta, extrae los inmuebles del apartado 'Rendimientos del capital inmobiliario' (bienes inmuebles arrendados).
   - Por cada inmueble, extrae:
     * Dirección completa ('address').
     * Referencia catastral ('cadastralReference'): Cadena alfanumérica de exactamente 20 caracteres (ej: '9872301VK4797S0003TR').
     * Propietario ('owner'): 'user1', 'user2' o 'both' (si pertenece al 50% a cada uno, o indica titularidad compartida / cónyuge / compartida).
     * Porcentajes ('ownershipPercentageUser1' y 'ownershipPercentageUser2'): Ej. 100 y 0, 0 y 100, o 50 y 50.
     * Alquiler mensual ('monthlyRent'): Es el alquiler bruto percibido. 
       - Si lo extraes de la Renta, la Casilla 0102 es ANUAL. ¡DEBES DIVIDIRLA ENTRE 12 para obtener el valor mensual! Si está al 50%, multiplícala por 2 antes para reflejar el 100% de la renta total del inmueble.
       - Si figura en el listado de inmuebles (Documento 3), úsalo directamente (asegúrate de si es mensual o anual; si indica cantidades de ~500-2000, suele ser mensual. Si indica ~6000-24000, es anual y debes dividir entre 12).
     * Precio de compra ('purchasePrice'): Extrae el valor de adquisición del inmueble. Si no figura, intenta estimarlo razonablemente o pon 0 si no hay ninguna indicación.
     * Amortización anual ('amortizationAmount'): Es la Casilla 0115 de la Renta. Si no figura, estímala como el 3% del valor de construcción (el 75% del precio de compra).
     * Datos del inquilino ('tenantName' y 'tenantDni'): Búscalos en los anexos de la renta (Casilla 0105 o datos del arrendatario) o en el listado de inmuebles. Extrae nombres y NIFs reales de los inquilinos.
     * Gastos deducibles anuales al 100%: Comunidad ('expensesCommunity'), IBI ('expensesIBI', Casilla 0107), Seguro ('expensesInsurance'), y Reparaciones/Mantenimiento ('expensesRepairs', Casilla 0109). Si en la renta vienen prorrateados por tu porcentaje de propiedad, multiplícalos para reflejar el 100% del gasto total del inmueble.

4. AUSENCIA DE DECLARACIONES DE RENTA O DATOS DE IDENTIDAD (MUY IMPORTANTE):
   - Si NO se proporciona ningún documento de declaración de la renta (Documento 1 ni Documento 2), o si en los documentos aportados no constan explícitamente los nombres y DNIs de los contribuyentes:
     * ¡ESTÁ TERMINANTEMENTE PROHIBIDO INVENTAR, ALUCINAR O ESTIMAR nombres o DNIs ficticios!
     * Pon exactamente de nombre "Usuario 1" para 'user1' y su DNI en cadena vacía "".
     * Pon exactamente de nombre "Usuario 2" para 'user2', su DNI en cadena vacía "" y establece 'hasPartner': false.
     * Establece los campos de rentas del trabajo ('brutoTrabajo' y 'netoTrabajo') a "0" para ambos. No simules salarios.

CRUZA Y COMBINA la información con sumo cuidado. Evita duplicar inmuebles. Asegúrate de que los importes numéricos corresponden al 100% del inmueble y que las cantidades de sueldos corresponden al año completo.`;

      const contents: any[] = [];

      // 1. Process and add Tax return 1 file if present
      if (fileData1 && mimeType1) {
        contents.push({ text: "--- DOCUMENTO 1: DECLARACIÓN RENTA USUARIO 1 (PDF) ---" });
        contents.push({
          inlineData: {
            mimeType: mimeType1,
            data: fileData1
          }
        });
      } else if (text1) {
        contents.push({ text: `--- DOCUMENTO 1: TEXTO RENTA USUARIO 1 ---\n\n${text1}` });
      }

      // 2. Process and add Tax return 2 file if present
      if (fileData2 && mimeType2) {
        contents.push({ text: "--- DOCUMENTO 2: DECLARACIÓN RENTA USUARIO 2 (PDF) ---" });
        contents.push({
          inlineData: {
            mimeType: mimeType2,
            data: fileData2
          }
        });
      } else if (text2) {
        contents.push({ text: `--- DOCUMENTO 2: TEXTO RENTA USUARIO 2 ---\n\n${text2}` });
      }

      // 3. Process and add Properties file if present
      if (propertiesFileData && propertiesFileMime) {
        const isExcel = propertiesFileMime.includes("sheet") || 
                        propertiesFileMime.includes("excel") || 
                        propertiesFileMime.includes("spreadsheetml") ||
                        (propertiesFileName && (propertiesFileName.toLowerCase().endsWith(".xlsx") || propertiesFileName.toLowerCase().endsWith(".xls")));
        
        if (isExcel) {
          try {
            console.log(`[Excel Parser] Parsing properties spreadsheet ${propertiesFileName}`);
            const buffer = Buffer.from(propertiesFileData, "base64");
            const workbook = XLSX.read(buffer, { type: "buffer" });
            const sheetTexts: string[] = [];
            for (const sheetName of workbook.SheetNames) {
              const worksheet = workbook.Sheets[sheetName];
              const csv = XLSX.utils.sheet_to_csv(worksheet);
              sheetTexts.push(`Hoja: ${sheetName}\n${csv}`);
            }
            const excelText = sheetTexts.join("\n\n---\n\n");
            contents.push({ text: `--- DOCUMENTO 3: DATOS DE INMUEBLES (EXCEL PARSEADO A CSV) ---\n\n${excelText}` });
          } catch (excelErr: any) {
            console.error("Error parsing Excel on server:", excelErr);
            contents.push({ text: `[Error leyendo Excel: ${excelErr.message}]` });
          }
        } else if (propertiesFileMime === "application/pdf") {
          contents.push({ text: "--- DOCUMENTO 3: DATOS DE INMUEBLES (PDF) ---" });
          contents.push({
            inlineData: {
              mimeType: "application/pdf",
              data: propertiesFileData
            }
          });
        } else {
          // Plain Text/CSV properties file
          const plainText = Buffer.from(propertiesFileData, "base64").toString("utf-8");
          contents.push({ text: `--- DOCUMENTO 3: DATOS DE INMUEBLES (TEXTO/CSV) ---\n\n${plainText}` });
        }
      }

      const response = await generateContentWithRetry(
        contents,
        {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              user1: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Nombre completo del Contribuyente 1" },
                  dni: { type: Type.STRING, description: "DNI o NIF del Contribuyente 1" },
                  brutoTrabajo: { type: Type.STRING, description: "Rendimientos íntegros del trabajo anuales (bruto) de User 1 (ej: '36200.50' o '36.200,00' o '36200')" },
                  netoTrabajo: { type: Type.STRING, description: "Rendimiento neto de trabajo anual de User 1 (ej: '30120.00' o '30.120,50')" }
                },
                required: ["name", "dni", "brutoTrabajo", "netoTrabajo"]
              },
              user2: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Nombre completo del Contribuyente 2 (Cónyuge)" },
                  dni: { type: Type.STRING, description: "DNI o NIF del Contribuyente 2" },
                  brutoTrabajo: { type: Type.STRING, description: "Rendimientos íntegros del trabajo anuales (bruto) de User 2" },
                  netoTrabajo: { type: Type.STRING, description: "Rendimiento neto de trabajo anual de User 2" },
                  hasPartner: { type: Type.BOOLEAN, description: "Indica si se ha detectado cónyuge o pareja en el documento" }
                },
                required: ["name", "dni", "brutoTrabajo", "netoTrabajo", "hasPartner"]
              },
              properties: {
                type: Type.ARRAY,
                description: "Lista de todos los inmuebles arrendados detectados",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    address: { type: Type.STRING, description: "Dirección o emplazamiento del inmueble" },
                    cadastralReference: { type: Type.STRING, description: "Referencia Catastral (20 caracteres)" },
                    owner: { type: Type.STRING, description: "Quién es el dueño: 'user1', 'user2' o 'both'" },
                    ownershipPercentageUser1: { type: Type.STRING, description: "Porcentaje de propiedad del Contribuyente 1 (0-100) (ej: '50' o '100')" },
                    ownershipPercentageUser2: { type: Type.STRING, description: "Porcentaje de propiedad del Contribuyente 2 / Cónyuge (0-100) (ej: '50' o '0')" },
                    tenantName: { type: Type.STRING, description: "Nombres completos de TODOS los inquilinos, separados por comas (ej. 'Juan Pérez, María Gómez')" },
                    tenantDni: { type: Type.STRING, description: "NIF/DNI de TODOS los inquilinos, en el mismo orden y separados por comas (ej. '12345678Z, 87654321X')" },
                    monthlyRent: { type: Type.STRING, description: "Importe del alquiler mensual (si es anual, divídelo entre 12. Ej: '800' o '800.50')" },
                    purchasePrice: { type: Type.STRING, description: "Precio de compra o coste de adquisición del inmueble" },
                    landValuePercent: { type: Type.STRING, description: "Porcentaje catastral asignado al suelo (habitualmente entre 20% y 30%). Por defecto '25'" },
                    amortizationAmount: { type: Type.STRING, description: "Importe de amortización deducible anual (usar el del texto o estimar el 3% del valor de construcción)" },
                    expensesCommunity: { type: Type.STRING, description: "Gastos anuales estimados de comunidad" },
                    expensesIBI: { type: Type.STRING, description: "Gastos anuales estimados de IBI (Impuesto de Bienes Inmuebles)" },
                    expensesInsurance: { type: Type.STRING, description: "Gastos anuales de seguro de hogar / impago" },
                    expensesRepairs: { type: Type.STRING, description: "Gastos anuales de mantenimiento o reparaciones" }
                  },
                  required: ["address", "cadastralReference", "owner", "tenantName", "tenantDni", "monthlyRent", "purchasePrice", "landValuePercent", "amortizationAmount"]
                }
              }
            },
            required: ["user1", "user2", "properties"]
          }
        },
        "gemini-3.5-flash"
      );

      const textOutput = response.text;
      if (!textOutput) {
        throw new Error("No se pudo obtener una respuesta válida del modelo Gemini.");
      }

      const cleanedText = cleanJsonText(textOutput);
      const parsedData = JSON.parse(cleanedText);
      const sanitizedData = sanitizeExtractionResult(parsedData);
      res.json(sanitizedData);
    } catch (error: any) {
      console.error("Extraction error:", error);
      res.status(500).json({ error: error.message || "Error al procesar los documentos." });
    }
  });

  // API Route: Extract details from a receipt/invoice photo or PDF using Gemini 3.5 Flash
  app.post("/api/extract-invoice", async (req, res) => {
    try {
      const { fileData, mimeType } = req.body;
      
      if (!fileData || !mimeType) {
        res.status(400).json({ error: "Debe proporcionar el archivo de factura o recibo (imagen o PDF) codificado en Base64." });
        return;
      }

      const systemPrompt = `Eres un experto fiscal de la Agencia Tributaria Española (AEAT).
Tu tarea es analizar la imagen o PDF de una factura, recibo o comprobante de un gasto relacionado con una propiedad en alquiler, y extraer de forma extremadamente precisa la información necesaria para integrarla en la contabilidad fiscal del propietario.

Debes categorizar el gasto de forma inteligente de acuerdo con las siguientes categorías oficiales españolas de IRPF:
- 'repairs' (reparaciones y conservación de la vivienda: fontanero, pintor, averías, reformas de mantenimiento).
- 'ibi' (tributos y recargos: IBI, tasa de basuras, vados, etc.).
- 'insurance' (primas de contratos de seguro: hogar, responsabilidad civil, seguro de impago de alquiler).
- 'community' (gastos de comunidad: cuotas ordinarias y extraordinarias de la comunidad de propietarios).
- 'maintenance' (servicios de mantenimiento de instalaciones, limpieza, suministros de agua, luz, gas, calefacción si los abona el propietario).
- 'other' (cualquier otro gasto deducible: honorarios de la inmobiliaria o gestoría por el contrato, intereses de préstamos de compra, etc.).

Devuelve los importes como números decimales y las fechas en formato YYYY-MM-DD.`;

      const contents: any[] = [
        { text: systemPrompt },
        { text: "--- DOCUMENTO DE RECIBO/FACTURA ---" },
        {
          inlineData: {
            mimeType: mimeType,
            data: fileData
          }
        }
      ];

      const response = await generateContentWithRetry(
        contents,
        {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              amount: { type: Type.NUMBER, description: "Importe total del recibo o factura con decimales (float)." },
              date: { type: Type.STRING, description: "Fecha de emisión del recibo/factura en formato YYYY-MM-DD." },
              nif: { type: Type.STRING, description: "NIF/CIF o DNI del emisor o proveedor de la factura." },
              description: { type: Type.STRING, description: "Concepto o nombre del proveedor de forma resumida." },
              category: { 
                type: Type.STRING, 
                description: "Categoría fiscal exacta del gasto. Debe ser una de las siguientes opciones: 'repairs', 'ibi', 'insurance', 'community', 'maintenance', 'other'." 
              }
            },
            required: ["amount", "date", "description", "category"]
          }
        },
        "gemini-3.5-flash"
      );

      const textOutput = response.text;
      if (!textOutput) {
        throw new Error("No se pudo obtener una respuesta del modelo Gemini para la factura.");
      }

      const cleanedText = cleanJsonText(textOutput);
      const parsedData = JSON.parse(cleanedText);
      res.json(parsedData);
    } catch (error: any) {
      console.error("Invoice extraction error:", error);
      res.status(500).json({ error: error.message || "Error al procesar la factura con Gemini." });
    }
  });

  // API Route: Generate and Optimize rental contract clauses with Gemini 3.5 Flash
  app.post("/api/optimize-contract", async (req, res) => {
    try {
      const { contractContext, customPrompt } = req.body;
      if (!customPrompt) {
        res.status(400).json({ error: "Debe proporcionar condiciones de contrato y prompts de optimización." });
        return;
      }

      console.log("[server] Optimizing contract with Gemini AI...");
      
      const response = await generateContentWithRetry(
        [{ text: customPrompt }],
        {
          responseMimeType: "text/plain",
        },
        "gemini-3.5-flash"
      );

      const contractText = response.text;
      if (!contractText) {
        throw new Error("No se pudo generar el texto del contrato.");
      }

      res.json({ text: contractText });
    } catch (error: any) {
      console.error("Contract optimization error:", error);
      res.status(500).json({ error: error.message || "Error al optimizar el contrato con Gemini." });
    }
  });

  // Health route
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Serve static assets or use Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

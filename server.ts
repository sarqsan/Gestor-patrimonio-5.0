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

function cleanNameString(name: any, fallbackDefault: string): string {
  if (name === undefined || name === null) return fallbackDefault;
  
  let clean = String(name).trim();
  if (!clean) return fallbackDefault;
  
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

function cleanDniString(dni: any): string {
  if (dni === undefined || dni === null) return "";
  let clean = String(dni).trim().toUpperCase();
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
        const addrStr = String(cleanProp.address);
        cleanProp.address = addrStr.replace(/^[,;.\s\\\-\/]+/, "").replace(/[,;.\s\\\-\/]+$/, "").trim();
      } else {
        cleanProp.address = "";
      }
      
      if (cleanProp.cadastralReference) {
        const cadStr = String(cleanProp.cadastralReference);
        cleanProp.cadastralReference = cadStr.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      } else {
        cleanProp.cadastralReference = "";
      }
      
      if (cleanProp.tenantName) {
        const tNameStr = String(cleanProp.tenantName);
        cleanProp.tenantName = tNameStr.replace(/^[,;.\s\\\-\/]+/, "").replace(/[,;.\s\\\-\/]+$/, "").trim();
        cleanProp.tenantName = cleanProp.tenantName.replace(/,+/g, ", ").replace(/\s+/g, " ").trim();
      } else {
        cleanProp.tenantName = "";
      }
      
      if (cleanProp.tenantDni) {
        const tDniStr = String(cleanProp.tenantDni);
        cleanProp.tenantDni = tDniStr.trim().toUpperCase().replace(/[^A-Z0-9,\s]/g, "");
        cleanProp.tenantDni = cleanProp.tenantDni.replace(/,+/g, ", ").replace(/\s+/g, " ").trim();
      } else {
        cleanProp.tenantDni = "";
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
Tu tarea es analizar la declaración de la renta de España (IRPF, Modelo 100, Borrador, Resumen de la Declaración o Datos Fiscales) y/o el documento de listado de inmuebles adjunto (Excel, CSV o PDF) de uno o dos contribuyentes (pareja/cónyuges) y extraer con la máxima precisión la información sobre sus rentas del trabajo y sus inmuebles arrendados.

Sigue rigurosamente estas pautas para una extracción 100% precisa, inteligente y libre de fallos:

1. IDENTIFICACIÓN DE LOS CONTRIBUYENTES (USER 1 / USER 2):
   - El primer declarante o titular que aparezca es 'user1'. El cónyuge o segundo declarante es 'user2'.
   - Extrae el nombre completo y el DNI/NIF/NIE. Limpia textos sobrantes como "DECLARANTE", "S.PASIVO", "CÓNYUGE", "NIF:", etc.
   - Si no hay cónyuge ni segundo declarante en el documento, establece 'hasPartner': false.

2. RENDIMIENTOS DEL TRABAJO (Sueldos y salarios):
   - Extrae los ingresos brutos ('brutoTrabajo') de la Casilla 0012 ("Suma de rendimientos íntegros") o Casilla 0003 ("Retribuciones en dinero"), o de las columnas de la tabla resumen de la declaración.
   - Extrae el rendimiento neto ('netoTrabajo') de la Casilla 0022 ("Rendimiento neto reducido") o Casilla 0018 ("Rendimiento neto del trabajo").
   - Si no hay rendimientos del trabajo, pon "0".

3. RENDIMIENTOS DEL CAPITAL INMOBILIARIO Y LISTADO DE INMUEBLES:
   - Extrae todos los inmuebles de la sección de arrendamientos (capital inmobiliario).
   - Por cada inmueble, extrae:
     * Dirección completa ('address').
     * Referencia catastral ('cadastralReference'): Cadena alfanumérica de 20 caracteres. Si el documento tiene guiones o espacios, quítalos.
     * Propietario ('owner'): 'user1', 'user2' o 'both' (si pertenece al 50% a cada uno, o se indica titularidad conjunta/cónyuge).
     * Porcentajes de propiedad ('ownershipPercentageUser1' y 'ownershipPercentageUser2'): ej. "100" y "0", "0" y "100", o "50" y "50".
     * Alquiler mensual ('monthlyRent'): Es la renta total de mercado del inmueble (100%).
       - ¡REGLA DE ESCALADO DE INMUEBLES COMPARTIDOS (CRÍTICA)!: En la declaración de la renta individual de cada cónyuge, los importes se declaran de forma prorrateada (por ejemplo, al 50%). Si un inmueble pertenece al 50% a cada cónyuge, los ingresos anuales declarados de la Casilla 0102 corresponden al 50%. DEBES multiplicar la Casilla 0102 por 2 para reflejar el total anual del inmueble (100%), y luego dividirlo entre 12 para obtener el alquiler mensual correcto del inmueble.
       - Si no se especifica explícitamente alquiler, estima el mensual dividiendo los ingresos anuales de la Casilla 0102 entre los meses de alquiler o entre 12, escalado al 100%.
     * Datos del inquilino ('tenantName' y 'tenantDni'): Búscalos en la Casilla 0105, anexos o información adicional. Si hay varios inquilinos, sepáralos por comas. Si no constan, pon "".
     * Precio de compra ('purchasePrice'): Extrae el valor de adquisición si consta. Si no consta, pon "0" o una estimación inteligente.
     * Amortización anual ('amortizationAmount'): Es la Casilla 0115 de la Renta. Si viene prorrateada al 50%, multiplícala por 2 para representar el 100%. Si no figura, pon "0".
     * Gastos deducibles anuales (IBI: Casilla 0107, Reparaciones: Casilla 0109, Seguros: Casilla 0110 o agrupación de seguros, Comunidad: Casilla 0104 o gastos de comunidad). Recuerda escalar todos estos gastos anuales al 100% de la propiedad si vienen prorrateados (multiplicándolos por 2 si la propiedad es del 50%).

4. TOLERANCIA Y ROBUSTEZ:
   - Si no puedes encontrar o deducir un valor para campos opcionales como gastos, DNI del inquilino, nombre del inquilino o precio de compra, NO dejes de extraer el inmueble. Pon simplemente "0" o cadena vacía "" para esos campos opcionales, pero extrae siempre el inmueble si tiene dirección y/o referencia catastral.
   - Si no hay cónyuge, omite los detalles de 'user2' o establécelos como vacíos de manera natural.`;

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
                  brutoTrabajo: { type: Type.STRING, description: "Rendimientos íntegros del trabajo anuales (bruto) de User 1" },
                  netoTrabajo: { type: Type.STRING, description: "Rendimiento neto de trabajo anual de User 1" }
                },
                required: ["name"]
              },
              user2: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Nombre completo del Contribuyente 2 (Cónyuge)" },
                  dni: { type: Type.STRING, description: "DNI o NIF del Contribuyente 2" },
                  brutoTrabajo: { type: Type.STRING, description: "Rendimientos íntegros del trabajo anuales (bruto) de User 2" },
                  netoTrabajo: { type: Type.STRING, description: "Rendimiento neto de trabajo anual de User 2" },
                  hasPartner: { type: Type.BOOLEAN, description: "Indica si se ha detectado cónyuge o pareja" }
                },
                required: ["name", "hasPartner"]
              },
              properties: {
                type: Type.ARRAY,
                description: "Lista de todos los inmuebles arrendados detectados",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    address: { type: Type.STRING, description: "Dirección o emplazamiento del inmueble" },
                    cadastralReference: { type: Type.STRING, description: "Referencia Catastral (20 caracteres)" },
                    owner: { type: Type.STRING, description: "Propietario: 'user1', 'user2' o 'both'" },
                    ownershipPercentageUser1: { type: Type.STRING, description: "Porcentaje de propiedad del Contribuyente 1 (0-100)" },
                    ownershipPercentageUser2: { type: Type.STRING, description: "Porcentaje de propiedad del Contribuyente 2 / Cónyuge (0-100)" },
                    tenantName: { type: Type.STRING, description: "Nombres completos de los inquilinos" },
                    tenantDni: { type: Type.STRING, description: "NIF/DNI de los inquilinos" },
                    monthlyRent: { type: Type.STRING, description: "Importe del alquiler mensual total (100% de la propiedad)" },
                    purchasePrice: { type: Type.STRING, description: "Precio de compra o coste de adquisición" },
                    landValuePercent: { type: Type.STRING, description: "Porcentaje catastral del suelo (ej: '25')" },
                    amortizationAmount: { type: Type.STRING, description: "Importe de amortización anual total (100% de la propiedad)" },
                    expensesCommunity: { type: Type.STRING, description: "Gastos anuales totales de comunidad (100%)" },
                    expensesIBI: { type: Type.STRING, description: "Gastos anuales totales de IBI (100%)" },
                    expensesInsurance: { type: Type.STRING, description: "Gastos anuales totales de seguro (100%)" },
                    expensesRepairs: { type: Type.STRING, description: "Gastos anuales totales de mantenimiento/reparaciones (100%)" }
                  },
                  required: ["address", "cadastralReference"]
                }
              }
            },
            required: ["user1", "properties"]
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

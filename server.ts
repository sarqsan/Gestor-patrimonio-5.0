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
Tu tarea es analizar la declaración de la renta de España (IRPF, Modelo 100) (que puede ser del Contribuyente 1, del Contribuyente 2 o conjunta) y/o el documento de listado de inmuebles adjunto (que puede ser texto, PDF oficial o listado Excel/CSV parseado) de uno o dos contribuyentes (pareja/cónyuges) y extraer TODA la información relevante sobre sus rentas del trabajo y sus inmuebles arrendados.

Sigue rigurosamente estas pautas para una extracción 100% precisa:

1. IDENTIFICACIÓN DE LOS CONTRIBUYENTES (USER 1 / USER 2):
   - IMPORTANTE: Puedes recibir uno o dos documentos de declaración de renta. Extrae SIEMPRE con total prioridad el nombre y DNI del Declarante Principal (que irá en 'user1') y del Cónyuge (que irá en 'user2'). Bajo ningún concepto dejes a 'user1' con datos ficticios o vacíos si en el documento hay un declarante principal.
   - Si recibes DOS documentos de declaración separados (DOCUMENTO 1 y DOCUMENTO 2):
     * El 'Declarante' o 'Primer declarante' o 'Sujeto Pasivo' que aparezca en el DOCUMENTO 1 es el Contribuyente 1 (User 1). Extrae su nombre completo y su NIF/DNI que figura en ese DOCUMENTO 1.
     * El 'Declarante' o 'Primer declarante' o 'Sujeto Pasivo' que aparezca en el DOCUMENTO 2 es el Contribuyente 2 (User 2). Extrae su nombre completo y su NIF/DNI que figura en ese DOCUMENTO 2. Establece 'hasPartner': true en el objeto de 'user2'.
     * Asocia los ingresos de trabajo ('brutoTrabajo' y 'netoTrabajo') del DOCUMENTO 1 a 'user1', y los del DOCUMENTO 2 a 'user2'.
   - Si recibes UN SOLO documento de declaración:
     * El 'Declarante' o 'Primer declarante' o 'Sujeto pasivo' es el Contribuyente 1 (User 1). Extrae su nombre completo y su NIF/DNI de la primera página (apartado 'Datos identificativos' o cabecera).
     * El 'Cónyuge' o 'Segundo declarante' (si figura en el documento) es el Contribuyente 2 (User 2). Extrae su nombre completo y su NIF/DNI si están presentes, y establece 'hasPartner': true. Si no hay cónyuge ni segundo declarante en ese documento, establece 'hasPartner': false.
   - DETECCIÓN DE ROLES CRÍTICA: El declarante principal puede ser un hombre o una mujer. Si el documento tiene como primer declarante a una persona (ej: mujer) y cónyuge a otra (ej: hombre), asócialos correctamente a 'user1' (Declarante) y 'user2' (Cónyuge) respectivamente. ¡NUNCA dejes a 'user1' vacío o con "PROPIETARIO PRINCIPAL" si hay un nombre legible!
   - Si los nombres vienen con apellidos primero (ej. 'SANCHEZ PEREZ, JUAN' o 'PEREZ GOMEZ, MARIA PILAR'), devuélvelos en orden natural ('Juan Sánchez Pérez' o 'María Pilar Pérez Gómez') o exactamente como figuren de manera limpia (sin caracteres extraños ni códigos de casillas). El DNI/NIF debe tener sus 8 dígitos y la letra (ej. '12345678Z').

2. RENDIMIENTOS DEL TRABAJO (Sueldos y salarios):
   - Busca en la sección titulada 'A. Rendimientos del trabajo' o 'Rendimientos del trabajo'.
   - Ingresos brutos ('brutoTrabajo'): Busca la casilla 0012 ('Suma de rendimientos íntegros') o la casilla 0003 ('Retribuciones en dinero'). Este es el total anual de ingresos por sueldo antes de deducciones. Debe ser un importe anual real (por ejemplo, entre 12.000 y 90.000 €).
   - Rendimiento neto ('netoTrabajo'): Busca la casilla 0022 ('Rendimiento neto reducido del trabajo') o la casilla 0018 ('Rendimiento neto del trabajo'). Este es el rendimiento del trabajo después de deducir gastos como la Seguridad Social (casilla 0013) y la reducción por obtención de rendimientos.
   - En una declaración conjunta de IRPF, suele haber tres columnas de importes: 'Declarante', 'Cónyuge' y 'Conjunta'. Extrae meticulosamente los importes de la columna 'Declarante' para 'user1', y los de la columna 'Cónyuge' para 'user2'. ¡NO uses el total de la columna 'Conjunta' para el sueldo individual!

3. RENDIMIENTOS DEL CAPITAL INMOBILIARIO (Inmuebles Arrendados):
   - Busca el apartado 'Rendimientos del capital inmobiliario' (bienes inmuebles arrendados o cedidos a terceros).
   - Por cada inmueble arrendado que figure en la declaración, extrae:
     * Dirección completa (address): El emplazamiento o calle de la propiedad.
     * Referencia catastral (cadastralReference): Cadena alfanumérica de exactamente 20 caracteres (ej: '9872301VK4797S0003TR').
     * Propietario (owner): Determina si pertenece a 'user1', 'user2' o 'both'. Esto se basa en la titularidad declarada. Si se declara en la renta de User 1 al 50%, significa que la titularidad es compartida (owner = 'both').
     * Porcentajes de titularidad (ownershipPercentageUser1 y ownershipPercentageUser2): Si es 100% de User 1, pon 100 y 0. Si es compartido al 50%, pon 50 y 50.
     * Datos del inquilino (tenantName y tenantDni): Busca el nombre del inquilino y su NIF/DNI, que obligatoriamente se declaran en la casilla 0105 (NIF del arrendatario) o campos anexos de datos del arrendamiento.
     * Alquiler mensual percibido ('monthlyRent'): Busca los ingresos íntegros anuales (casilla 0102) del inmueble. ¡ATENCIÓN! Como este valor es ANUAL, DEBES DIVIDIRLO ENTRE 12 para calcular el alquiler mensual estimado. Si la titularidad es compartida (ej: 50%) y el valor de la casilla 0102 está prorrateado (por ejemplo, indica 5.400 € correspondientes al 50%), multiplícalo por 2 para obtener el 100% (10.800 € anuales) y luego divídelo entre 12 (900 € mensuales). ¡Devuelve siempre importes financieros referidos al 100% absoluto de la propiedad!
     * Amortización anual ('amortizationAmount'): Busca la casilla 0115 ('Amortización'). Si no figura o es cero, calcula el 3% del valor de construcción (por defecto el 75% del valor de compra o adquisición).
     * Gastos deducibles:
       - IBI (casilla 0107 o tributos)
       - Comunidad (gastos de comunidad)
       - Seguro (primas de contrato de seguro)
       - Reparaciones y conservación (casilla 0109 o gastos de conservación)
       Si estos importes en la declaración están prorrateados, multiplícalos para reflejar el 100% absoluto de los gastos del inmueble entero.

Combina y cruza la información de la declaración y del archivo de inmuebles Excel para rellenar todos los campos del JSON de forma exhaustiva y lógica, sin duplicar inmuebles.`;

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
                  brutoTrabajo: { type: Type.NUMBER, description: "Rendimientos íntegros del trabajo anuales (bruto) de User 1" },
                  netoTrabajo: { type: Type.NUMBER, description: "Rendimiento neto de trabajo anual de User 1" }
                },
                required: ["name", "dni", "brutoTrabajo", "netoTrabajo"]
              },
              user2: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Nombre completo del Contribuyente 2 (Cónyuge)" },
                  dni: { type: Type.STRING, description: "DNI o NIF del Contribuyente 2" },
                  brutoTrabajo: { type: Type.NUMBER, description: "Rendimientos íntegros del trabajo anuales (bruto) de User 2" },
                  netoTrabajo: { type: Type.NUMBER, description: "Rendimiento neto de trabajo anual de User 2" },
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
                    ownershipPercentageUser1: { type: Type.NUMBER, description: "Porcentaje de propiedad del Contribuyente 1 (0-100)" },
                    ownershipPercentageUser2: { type: Type.NUMBER, description: "Porcentaje de propiedad del Contribuyente 2 / Cónyuge (0-100)" },
                    tenantName: { type: Type.STRING, description: "Nombres completos de TODOS los inquilinos, separados por comas (ej. 'Juan Pérez, María Gómez')" },
                    tenantDni: { type: Type.STRING, description: "NIF/DNI de TODOS los inquilinos, en el mismo orden y separados por comas (ej. '12345678Z, 87654321X')" },
                    monthlyRent: { type: Type.NUMBER, description: "Importe del alquiler mensual (si es anual, divídelo entre 12)" },
                    purchasePrice: { type: Type.NUMBER, description: "Precio de compra o coste de adquisición del inmueble" },
                    landValuePercent: { type: Type.NUMBER, description: "Porcentaje catastral asignado al suelo (habitualmente entre 20% y 30%). Por defecto 25" },
                    amortizationAmount: { type: Type.NUMBER, description: "Importe de amortización deducible anual (usar el del texto o estimar el 3% del valor de construcción)" },
                    expensesCommunity: { type: Type.NUMBER, description: "Gastos anuales estimados de comunidad" },
                    expensesIBI: { type: Type.NUMBER, description: "Gastos anuales estimados de IBI (Impuesto de Bienes Inmuebles)" },
                    expensesInsurance: { type: Type.NUMBER, description: "Gastos anuales de seguro de hogar / impago" },
                    expensesRepairs: { type: Type.NUMBER, description: "Gastos anuales de mantenimiento o reparaciones" }
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
      res.json(parsedData);
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

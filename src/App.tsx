import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";
import ReactMarkdown from 'react-markdown';
import { 
  Brain, 
  User, 
  MessageSquare, 
  Loader2, 
  BookOpen, 
  Heart, 
  Zap, 
  ShieldAlert,
  ChevronRight,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  RefreshCcw,
  Play,
  History,
  Users,
  LogOut,
  Phone,
  Image as ImageIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Podcast {
  title: string;
  text: string;
  link: string;
  mp3_url: string;
}

interface UserData {
  id: number;
  phone: string;
}

interface SavedQuery {
  id: number;
  problem: string;
  answer: string;
  personality: string;
  style: string;
  language: string;
  images: string[];
  user_phone?: string;
  created_at: string;
}

const LANGUAGES = [
  { id: 'fa', label: 'فارسی', dir: 'rtl' },
  { id: 'en', label: 'English', dir: 'ltr' },
  { id: 'tr', label: 'Türkçe', dir: 'ltr' },
  { id: 'ar', label: 'العربية', dir: 'rtl' },
];

const TRANSLATIONS: Record<string, any> = {
  fa: {
    welcome: 'خوش آمدید',
    start: 'شروع ارزیابی شخصیت',
    phonePlaceholder: 'ایمیل یا شماره موبایل',
    login: 'ورود / ثبت‌نام',
    assessment: 'ارزیابی شخصیت',
    style: 'سبک پاسخگویی',
    chat: 'دستیار هوشمند',
    history: 'تاریخچه من',
    public: 'تجربیات دیگران',
    problemPlaceholder: 'سوال یا مشکل خود را مطرح کنید...',
    analyze: 'دریافت تحلیل و راهکار',
    articleMode: 'حالت مقاله پیشرفته',
    articleDesc: 'تولید محتوای عمیق با تصاویر مفهومی و ساختار بصری خیره‌کننده',
    personalityIdentified: 'شخصیت شناسایی شده:',
    newQuestion: 'سوال جدید',
    logout: 'خروج',
    loading: 'در حال تحلیل پادکست‌ها...',
    error: 'خطایی رخ داد. لطفا دوباره تلاش کنید.',
    language: 'زبان',
    anonymous: 'ناشناس',
    aboutYou: 'کمی از خودتان بگویید',
    aboutYouDesc: 'توضیح کوتاهی درباره شرایط فعلی، سن یا هر چیزی که فکر می‌کنید به تحلیل بهتر کمک می‌کند.',
    aboutYouPlaceholder: 'مثلاً: من ۳۰ ساله هستم و اخیراً در محیط کار دچار استرس شده‌ام...',
    next: 'بعدی',
  },
  en: {
    welcome: 'Welcome',
    start: 'Start Personality Assessment',
    phonePlaceholder: 'Email or Phone number',
    login: 'Login / Register',
    assessment: 'Personality Assessment',
    style: 'Response Style',
    chat: 'Smart Assistant',
    history: 'My History',
    public: 'Public Feed',
    problemPlaceholder: 'Ask your question or describe your problem...',
    analyze: 'Get Analysis & Solutions',
    articleMode: 'Advanced Article Mode',
    articleDesc: 'Deep content with conceptual images and stunning visual structure',
    personalityIdentified: 'Identified Personality:',
    newQuestion: 'New Question',
    logout: 'Logout',
    loading: 'Analyzing podcasts...',
    error: 'An error occurred. Please try again.',
    language: 'Language',
    anonymous: 'Anonymous',
    aboutYou: 'Tell us about yourself',
    aboutYouDesc: 'A brief description of your situation, age, or anything that helps with the analysis.',
    aboutYouPlaceholder: 'e.g., I am 30 years old and recently stressed at work...',
    next: 'Next',
  },
};

const ASSESSMENT_QUESTIONS = [
  {
    id: 'q1',
    question: {
      fa: 'وقتی با یک چالش جدید روبرو می‌شوید، اولین واکنش شما چیست؟',
      en: 'When faced with a new challenge, what is your first reaction?'
    },
    options: [
      { text: { fa: 'احساساتم درگیر می‌شود و ممکن است نگران شوم.', en: 'I get emotional and might worry.' }, trait: 'sensitive' },
      { text: { fa: 'سعی می‌کنم خونسرد باشم و ابعاد منطقی موضوع را بررسی کنم.', en: 'I try to stay calm and analyze the logical aspects.' }, trait: 'logical' },
      { text: { fa: 'بلافاصله سناریوهای بد احتمالی به ذهنم می‌رسد.', en: 'Bad scenarios immediately come to mind.' }, trait: 'anxious' },
      { text: { fa: 'به این فکر می‌کنم که چطور می‌توانم آن را به بهترین شکل ممکن انجام دهم.', en: 'I think about how to do it perfectly.' }, trait: 'perfectionist' }
    ]
  },
  {
    id: 'q2',
    question: {
      fa: 'در روابط بین‌فردی، کدام مورد برای شما اولویت دارد؟',
      en: 'In interpersonal relationships, what is your priority?'
    },
    options: [
      { text: { fa: 'درک متقابل احساسات و همدلی عمیق.', en: 'Mutual understanding and deep empathy.' }, trait: 'sensitive' },
      { text: { fa: 'صداقت، وضوح و حل مسائل به صورت ریشه‌ای.', en: 'Honesty, clarity, and solving issues at the root.' }, trait: 'logical' },
      { text: { fa: 'داشتن امنیت و اطمینان خاطر از طرف مقابل.', en: 'Having security and reassurance from the other person.' }, trait: 'anxious' },
      { text: { fa: 'رعایت نظم، اصول و استانداردهای اخلاقی بالا.', en: 'Maintaining order, principles, and high ethical standards.' }, trait: 'perfectionist' }
    ]
  },
  {
    id: 'q3',
    question: {
      fa: 'اگر کاری دقیقاً آن‌طور که می‌خواستید پیش نرود، چه حسی پیدا می‌کنید؟',
      en: 'If something doesn\'t go exactly as you wanted, how do you feel?'
    },
    options: [
      { text: { fa: 'خیلی ناراحت می‌شوم و ممکن است از خودم برنجم.', en: 'I get very upset and might blame myself.' }, trait: 'sensitive' },
      { text: { fa: 'تحلیل می‌کنم که کجای کار اشتباه بوده تا دفعه بعد اصلاحش کنم.', en: 'I analyze what went wrong to fix it next time.' }, trait: 'logical' },
      { text: { fa: 'دچار استرس می‌شوم که نکند عواقب بدی داشته باشد.', en: 'I get stressed about potential bad consequences.' }, trait: 'anxious' },
      { text: { fa: 'به شدت کلافه می‌شوم و تا نقص را برطرف نکنم آرام نمی‌گیرم.', en: 'I get extremely frustrated and won\'t rest until it\'s fixed.' }, trait: 'perfectionist' }
    ]
  }
];

const PERSONALITY_TRAITS: Record<string, { label: any, icon: any, description: any }> = {
  sensitive: { 
    label: { fa: 'حساس و همدل', en: 'Sensitive & Empathetic' }, 
    icon: Heart, 
    description: { fa: 'تمرکز بر دنیای درونی و احساسات', en: 'Focus on inner world and emotions' } 
  },
  logical: { 
    label: { fa: 'منطقی و تحلیل‌گر', en: 'Logical & Analytical' }, 
    icon: Brain, 
    description: { fa: 'تمرکز بر شواهد علمی و ساختارها', en: 'Focus on scientific evidence and structures' } 
  },
  anxious: { 
    label: { fa: 'مضطرب و محتاط', en: 'Anxious & Cautious' }, 
    icon: ShieldAlert, 
    description: { fa: 'نیاز به آرامش و اطمینان‌بخشی', en: 'Need for calm and reassurance' } 
  },
  perfectionist: { 
    label: { fa: 'کمال‌گرا و دقیق', en: 'Perfectionist & Precise' }, 
    icon: Zap, 
    description: { fa: 'تمرکز بر استانداردها و پذیرش نقص', en: 'Focus on standards and accepting flaws' } 
  },
};

const RESPONSE_STYLES = [
  { id: 'friendly', label: { fa: 'خودمانی و دوستانه', en: 'Friendly & Casual' }, description: { fa: 'لحنی گرم و صمیمی مثل یک گفتگوی دوستانه', en: 'Warm and intimate like a friendly chat' } },
  { id: 'formal', label: { fa: 'رسمی و آکادمیک', en: 'Formal & Academic' }, description: { fa: 'لحنی جدی، دقیق و علمی مشابه سخنرانی‌های دانشگاهی', en: 'Serious, precise, and scientific like academic lectures' } },
  { id: 'story', label: { fa: 'داستانی و روایی', en: 'Storytelling' }, description: { fa: 'استفاده از حکایت‌ها و تمثیل‌های جذاب برای انتقال مفاهیم', en: 'Using engaging anecdotes and parables to convey concepts' } },
  { id: 'example', label: { fa: 'مثال‌محور و کاربردی', en: 'Example-Based' }, description: { fa: 'تمرکز بر مثال‌های عینی و آزمایش‌های علمی معروف', en: 'Focus on concrete examples and famous scientific experiments' } },
];

export default function App() {
  const [lang, setLang] = useState('fa');
  const [step, setStep] = useState<'login' | 'welcome' | 'assessment' | 'about' | 'style' | 'chat' | 'history' | 'public'>('login');
  const [user, setUser] = useState<UserData | null>(null);
  const [phone, setPhone] = useState('');
  const [userContext, setUserContext] = useState('');
  const [assessmentStep, setAssessmentStep] = useState(0);
  const [traitScores, setTraitScores] = useState<Record<string, number>>({
    sensitive: 0,
    logical: 0,
    anxious: 0,
    perfectionist: 0
  });
  
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [problem, setProblem] = useState('');
  const [personality, setPersonality] = useState<string | null>(null);
  const [responseStyle, setResponseStyle] = useState('friendly');
  const [isArticleMode, setIsArticleMode] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [relevantSources, setRelevantSources] = useState<Podcast[]>([]);
  const [history, setHistory] = useState<SavedQuery[]>([]);
  const [publicFeed, setPublicFeed] = useState<SavedQuery[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const t = TRANSLATIONS[lang] || TRANSLATIONS.fa;
  const dir = LANGUAGES.find(l => l.id === lang)?.dir || 'rtl';

  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  useEffect(() => {
    fetch('/podcasts_db.json')
      .then(res => res.json())
      .then(data => setPodcasts(data))
      .catch(err => console.error('Error loading podcasts:', err));

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.lang = lang === 'fa' ? 'fa-IR' : 'en-US';
      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setProblem(prev => prev + ' ' + transcript);
        setIsListening(false);
      };
      recognitionRef.current.onend = () => setIsListening(false);
    }

    const savedUser = localStorage.getItem('mokri_user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
      setStep('welcome');
    }
  }, [lang]);

  const handleLogin = async () => {
    if (!phone.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: phone }),
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Login failed');
      }

      const data = await res.json();
      if (data.id) {
        setUser(data);
        localStorage.setItem('mokri_user', JSON.stringify(data));
        setStep('welcome');
      }
    } catch (err: any) {
      setError(err.message || t.error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchHistory = async () => {
    if (!user) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/history/${user.id}`);
      const data = await res.json();
      setHistory(data);
      setStep('history');
    } catch (err) {
      setError(t.error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchPublicFeed = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/public-feed');
      const data = await res.json();
      setPublicFeed(data);
      setStep('public');
    } catch (err) {
      setError(t.error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleVoiceInput = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      recognitionRef.current?.start();
      setIsListening(true);
    }
  };

  const handleSpeak = async (text: string) => {
    if (isSpeaking) {
      if (audioRef.current) {
        audioRef.current.pause();
        setIsSpeaking(false);
      }
      return;
    }

    setIsSpeaking(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const pcmData = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
        const wavHeader = new ArrayBuffer(44);
        const view = new DataView(wavHeader);
        view.setUint32(0, 0x52494646, false);
        view.setUint32(4, 36 + pcmData.length, true);
        view.setUint32(8, 0x57415645, false);
        view.setUint32(12, 0x666d7420, false);
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, 24000, true);
        view.setUint32(28, 24000 * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        view.setUint32(36, 0x64617461, false);
        view.setUint32(40, pcmData.length, true);

        const blob = new Blob([wavHeader, pcmData], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(blob);
        
        if (audioRef.current) {
          audioRef.current.src = audioUrl;
          audioRef.current.play().catch(e => console.error("Playback failed", e));
          audioRef.current.onended = () => {
            setIsSpeaking(false);
            URL.revokeObjectURL(audioUrl);
          };
        } else {
          const audio = new Audio(audioUrl);
          audioRef.current = audio;
          audio.play().catch(e => console.error("Playback failed", e));
          audio.onended = () => {
            setIsSpeaking(false);
            URL.revokeObjectURL(audioUrl);
          };
        }
      }
    } catch (err) {
      console.error('TTS Error:', err);
      setIsSpeaking(false);
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang === 'fa' ? 'fa-IR' : 'en-US';
      utterance.onend = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleOptionSelect = (trait: string) => {
    setTraitScores(prev => ({ ...prev, [trait]: prev[trait] + 1 }));
    if (assessmentStep < ASSESSMENT_QUESTIONS.length - 1) {
      setAssessmentStep(prev => prev + 1);
    } else {
      const finalTrait = Object.entries(traitScores).reduce((a, b) => a[1] > b[1] ? a : b)[0];
      setPersonality(finalTrait);
      setStep('about');
    }
  };

  const findRelevantContext = (query: string): Podcast[] => {
    if (!query || podcasts.length === 0) return [];
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    const scored = podcasts.map(p => {
      let score = 0;
      const content = (p.title + ' ' + p.text).toLowerCase();
      keywords.forEach(k => {
        if (content.includes(k)) score += 1;
      });
      return { ...p, score };
    });
    return scored
      .filter(p => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  };

  const handleAnalyze = async () => {
    if (!problem.trim()) return;

    setIsLoading(true);
    setError(null);
    setResult(null);
    setGeneratedImages([]);
    setRelevantSources([]);

    // Scroll to results area
    setTimeout(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }, 100);

    try {
      const relevantPodcasts = findRelevantContext(problem);
      setRelevantSources(relevantPodcasts);
      const contextText = relevantPodcasts.length > 0 
        ? relevantPodcasts.map(p => `عنوان: ${p.title}\nمتن: ${p.text}`).join('\n\n---\n\n')
        : "هیچ متن مرجع مستقیمی یافت نشد.";

      const trait = personality ? PERSONALITY_TRAITS[personality] : PERSONALITY_TRAITS.logical;
      const style = RESPONSE_STYLES.find(s => s.id === responseStyle) || RESPONSE_STYLES[0];

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            role: "user",
            parts: [{
              text: `
Role: You are the "Dr. Azarakhsh Mokri Smart Assistant". Respond in: ${lang}.
Style: ${style.label[lang] || style.label.fa}.
User Personality: ${trait.label[lang] || trait.label.fa}.
User Context (About them): ${userContext || 'Not provided'}.
Article Mode: ${isArticleMode ? 'ON' : 'OFF'}.

Instructions:
1. Tone: Analytical, compassionate, evidence-based.
2. Structure:
   - Deep Empathy & Understanding.
   - Root Cause Analysis.
   - :::important [Key Concept/Experiment]
     Explain a scientific experiment (e.g., Skinner's pigeons, Harlow's monkeys) or core psychological concept.
     :::
   - Practical Steps: Use ":::step [Number]\nDescription\n:::" for each step.
3. Content: 
   - If Article Mode is ON, be comprehensive and detailed (aim for high quality, around 800-1000 words).
   - Insert placeholders like "[IMAGE_PLACEHOLDER_1]", "[IMAGE_PLACEHOLDER_2]" in the middle of the text where a conceptual image would fit best.
4. Grounding: Use the provided context:
${contextText}

User's Problem: ${problem}
`
            }]
          }
        ],
        config: {
          temperature: 0.8,
        }
      });

      const textResult = response.text || "No response received.";
      setResult(textResult);

      const imgs: string[] = [];
      if (isArticleMode) {
        try {
          for (let i = 0; i < 3; i++) {
            const imageResponse = await ai.models.generateContent({
              model: 'gemini-2.5-flash-image',
              contents: [{
                text: `A professional, minimal, and purely conceptual psychological illustration for: ${problem}. No text. Symbolic representation. Style: soft colors, clean, high quality.`,
              }],
              config: { imageConfig: { aspectRatio: "16:9" } }
            });
            const part = imageResponse.candidates[0].content.parts.find(p => p.inlineData);
            if (part?.inlineData) imgs.push(`data:image/png;base64,${part.inlineData.data}`);
          }
          setGeneratedImages(imgs);
        } catch (imgErr) {
          console.error("Image generation failed", imgErr);
        }
      }

      if (user) {
        await fetch('/api/save-query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: user.id,
            userContext,
            problem,
            personality,
            style: responseStyle,
            language: lang,
            answer: textResult,
            images: imgs,
            isPublic: true
          }),
        });
      }

    } catch (err) {
      console.error(err);
      setError(t.error);
    } finally {
      setIsLoading(false);
    }
  };

  const renderMarkdown = (content: string) => {
    // 1. Handle Image Placeholders first
    let processedContent = content;
    generatedImages.forEach((img, idx) => {
      const placeholder = `[IMAGE_PLACEHOLDER_${idx + 1}]`;
      if (processedContent.includes(placeholder)) {
        if (img) {
          processedContent = processedContent.replace(placeholder, `:::image ${img}:::`);
        } else {
          processedContent = processedContent.replace(placeholder, '');
        }
      }
    });

    // 2. Split into blocks (images, steps, important boxes, and plain text)
    // We'll use a regex to find our custom tags
    const blockRegex = /(:::(?:important|step|image)[\s\S]*?:::)/g;
    const blocks = processedContent.split(blockRegex);

    return blocks.map((block, i) => {
      if (!block.startsWith(':::')) {
        return <ReactMarkdown key={i}>{block}</ReactMarkdown>;
      }

      // Handle Image Block
      if (block.startsWith(':::image')) {
        const url = block.replace(':::image ', '').replace(':::', '').trim();
        if (!url) return null;
        return (
          <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="my-10">
            <img src={url} alt="Analysis Illustration" className="rounded-[2.5rem] shadow-lg border border-gray-100 w-full" referrerPolicy="no-referrer" />
          </motion.div>
        );
      }

      // Handle Step Block
      if (block.startsWith(':::step')) {
        const stepContent = block.replace(':::step', '').replace(':::', '').trim();
        const lines = stepContent.split('\n');
        const numMatch = lines[0].match(/\[(.*?)\]/);
        const num = numMatch ? numMatch[1] : '?';
        const body = lines.slice(1).join('\n');
        return (
          <div key={i} className="step-item">
            <div className="step-number">{num}</div>
            <div className="step-content">
              <ReactMarkdown>{body}</ReactMarkdown>
            </div>
          </div>
        );
      }

      // Handle Important Box
      if (block.startsWith(':::important')) {
        const boxContent = block.replace(':::important', '').replace(':::', '').trim();
        const lines = boxContent.split('\n');
        const titleMatch = lines[0].match(/\[(.*?)\]/);
        const title = titleMatch ? titleMatch[1] : 'نکته مهم';
        const body = lines.slice(1).join('\n');
        return (
          <div key={i} className="callout-box">
            <div className="callout-box-header bg-emerald-600">
              <Zap className="w-5 h-5" />
              {title}
            </div>
            <div className="callout-box-body bg-emerald-50/30">
              <ReactMarkdown>{body}</ReactMarkdown>
            </div>
          </div>
        );
      }

      return null;
    });
  };

  return (
    <div className={`min-h-screen bg-[#f8f9fa] text-[#1a1a1a] font-sans p-4 md:p-8`} dir={dir}>
      <div className="max-w-4xl mx-auto">
        <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="p-3 bg-white rounded-2xl shadow-sm border border-emerald-100">
              <Brain className="w-8 h-8 text-emerald-600" />
            </motion.div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{t.chat}</h1>
              <p className="text-xs text-gray-500">{t.welcome}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex bg-white p-1 rounded-xl shadow-sm border border-gray-100">
              {LANGUAGES.map(l => (
                <button key={l.id} onClick={() => setLang(l.id)} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${lang === l.id ? 'bg-emerald-600 text-white' : 'text-gray-400 hover:bg-gray-50'}`}>
                  {l.label}
                </button>
              ))}
            </div>
            {user && (
              <div className="flex gap-2">
                <button onClick={fetchHistory} className="p-2 bg-white rounded-xl shadow-sm border border-gray-100 text-gray-500 hover:text-emerald-600" title={t.history}>
                  <History className="w-5 h-5" />
                </button>
                <button onClick={fetchPublicFeed} className="p-2 bg-white rounded-xl shadow-sm border border-gray-100 text-gray-500 hover:text-emerald-600" title={t.public}>
                  <Users className="w-5 h-5" />
                </button>
                <button onClick={() => { localStorage.removeItem('mokri_user'); setUser(null); setStep('login'); }} className="p-2 bg-white rounded-xl shadow-sm border border-gray-100 text-red-400 hover:text-red-600" title={t.logout}>
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="relative">
          <AnimatePresence mode="wait">
            {step === 'login' && (
              <motion.div key="login" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-emerald-900/5 border border-emerald-50 text-center">
                <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-8">
                  <Phone className="w-10 h-10 text-emerald-600" />
                </div>
                <h2 className="text-2xl font-bold mb-4">{t.login}</h2>
                <p className="text-gray-500 mb-8">{t.phonePlaceholder}</p>
                <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t.phonePlaceholder} className="w-full p-5 bg-gray-50 rounded-2xl border-2 border-transparent focus:border-emerald-500 focus:bg-white transition-all text-center text-xl mb-6" />
                {error && <div className="text-red-500 text-sm mb-4">{error}</div>}
                <button onClick={handleLogin} disabled={isLoading || !phone.trim()} className="w-full py-5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-bold transition-all shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-2">
                  {isLoading ? <Loader2 className="animate-spin" /> : t.login}
                </button>
              </motion.div>
            )}

            {step === 'welcome' && (
              <motion.div key="welcome" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-emerald-900/5 border border-emerald-50 text-center">
                <div className="mb-8">
                  <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-6">
                    <User className="w-10 h-10 text-emerald-600" />
                  </div>
                  <h2 className="text-2xl font-bold mb-4">{t.welcome}</h2>
                  <p className="text-gray-600 mb-8 leading-relaxed">{t.start}</p>
                </div>
                <button onClick={() => setStep('assessment')} className="w-full py-5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-bold transition-all shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-2">
                  {t.start}
                  <ChevronRight className={`w-5 h-5 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
                </button>
              </motion.div>
            )}

            {step === 'assessment' && (
              <motion.div key="assessment" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-emerald-900/5 border border-emerald-50">
                <div className="flex justify-between items-center mb-8">
                  <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full">{assessmentStep + 1} / {ASSESSMENT_QUESTIONS.length}</span>
                  <div className="flex gap-1">
                    {ASSESSMENT_QUESTIONS.map((_, i) => (
                      <div key={i} className={`h-1.5 rounded-full transition-all ${i <= assessmentStep ? 'w-6 bg-emerald-500' : 'w-2 bg-gray-100'}`} />
                    ))}
                  </div>
                </div>
                <h2 className="text-xl font-bold mb-8 leading-snug">{ASSESSMENT_QUESTIONS[assessmentStep].question[lang] || ASSESSMENT_QUESTIONS[assessmentStep].question.fa}</h2>
                <div className="space-y-3">
                  {ASSESSMENT_QUESTIONS[assessmentStep].options.map((option, idx) => (
                    <button key={idx} onClick={() => handleOptionSelect(option.trait)} className="w-full p-6 text-start bg-gray-50 hover:bg-emerald-50 border border-transparent hover:border-emerald-200 rounded-2xl transition-all group">
                      <span className="text-gray-700 group-hover:text-emerald-900">{option.text[lang] || option.text.fa}</span>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}

            {/* About You Step */}
            {step === 'about' && (
              <motion.div key="about" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-emerald-900/5 border border-emerald-50">
                <h2 className="text-2xl font-bold mb-2">{t.aboutYou}</h2>
                <p className="text-gray-500 mb-8">{t.aboutYouDesc}</p>
                <textarea
                  value={userContext}
                  onChange={(e) => setUserContext(e.target.value)}
                  placeholder={t.aboutYouPlaceholder}
                  className="w-full h-48 p-6 bg-gray-50 rounded-3xl border-none focus:ring-2 focus:ring-emerald-500 transition-all resize-none mb-8 text-lg"
                />
                <button
                  onClick={() => setStep('style')}
                  className="w-full py-5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-bold transition-all shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-2"
                >
                  {t.next}
                  <ChevronRight className={`w-5 h-5 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
                </button>
              </motion.div>
            )}

            {step === 'style' && (
              <motion.div key="style" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-emerald-900/5 border border-emerald-50">
                <h2 className="text-2xl font-bold mb-2">{t.style}</h2>
                <p className="text-gray-500 mb-8">Select how you want Dr. Mokri to respond.</p>
                <div className="grid grid-cols-1 gap-3 mb-8">
                  {RESPONSE_STYLES.map((style) => (
                    <button key={style.id} onClick={() => setResponseStyle(style.id)} className={`w-full p-6 text-start rounded-2xl border-2 transition-all ${responseStyle === style.id ? 'border-emerald-500 bg-emerald-50' : 'border-gray-100 hover:border-gray-200 bg-white'}`}>
                      <div className="font-bold text-gray-900">{style.label[lang] || style.label.fa}</div>
                      <div className="text-sm text-gray-500">{style.description[lang] || style.description.fa}</div>
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-between p-6 bg-gray-50 rounded-3xl mb-8">
                  <div>
                    <div className="font-bold text-gray-900">{t.articleMode}</div>
                    <div className="text-xs text-gray-500">{t.articleDesc}</div>
                  </div>
                  <button onClick={() => setIsArticleMode(!isArticleMode)} className={`w-14 h-7 rounded-full transition-all relative ${isArticleMode ? 'bg-emerald-600' : 'bg-gray-300'}`}>
                    <div className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all ${isArticleMode ? (dir === 'rtl' ? 'right-8' : 'left-8') : (dir === 'rtl' ? 'right-1' : 'left-1')}`} />
                  </button>
                </div>
                <button onClick={() => setStep('chat')} className="w-full py-5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-bold transition-all shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-2">
                  {t.chat}
                  <ChevronRight className={`w-5 h-5 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
                </button>
              </motion.div>
            )}

            {step === 'chat' && (
              <motion.div key="chat" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                {personality && (
                  <div className="flex items-center gap-4 p-5 bg-emerald-50 rounded-[2rem] border border-emerald-100">
                    <div className="p-3 bg-white rounded-2xl shadow-sm">
                      {(() => {
                        const Icon = PERSONALITY_TRAITS[personality].icon;
                        return <Icon className="w-6 h-6 text-emerald-600" />;
                      })()}
                    </div>
                    <div>
                      <div className="text-xs text-emerald-600 font-bold">{t.personalityIdentified}</div>
                      <div className="font-bold text-emerald-900">{PERSONALITY_TRAITS[personality].label[lang] || PERSONALITY_TRAITS[personality].label.fa}</div>
                    </div>
                    <button onClick={() => setStep('assessment')} className="mr-auto text-xs text-emerald-600 hover:underline flex items-center gap-1"><RefreshCcw className="w-3 h-3" /></button>
                  </div>
                )}
                <section className="bg-white rounded-[2.5rem] p-8 shadow-sm border border-black/5">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-2 text-emerald-600"><MessageSquare className="w-6 h-6" /><h2 className="font-bold text-lg">{t.problemPlaceholder}</h2></div>
                    <button onClick={handleVoiceInput} className={`p-4 rounded-full transition-all ${isListening ? 'bg-red-50 text-red-600 animate-pulse' : 'bg-gray-50 text-gray-400 hover:text-emerald-600'}`}>
                      {isListening ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                    </button>
                  </div>
                  <textarea value={problem} onChange={(e) => setProblem(e.target.value)} placeholder={t.problemPlaceholder} className="w-full h-48 p-6 bg-gray-50 rounded-3xl border-none focus:ring-2 focus:ring-emerald-500 transition-all resize-none mb-8 text-xl leading-relaxed" />
                  <button onClick={handleAnalyze} disabled={isLoading || !problem.trim()} className="w-full py-5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-2xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-600/20">
                    {isLoading ? <Loader2 className="animate-spin" /> : t.analyze}
                  </button>
                </section>
                {error && <div className="bg-red-50 text-red-600 p-5 rounded-2xl border border-red-100">{error}</div>}
                {result && (
                  <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-white rounded-[2.5rem] p-10 shadow-sm border border-black/5">
                    <div className="flex items-center justify-between mb-10">
                      <div className="flex items-center gap-3 text-emerald-600"><BookOpen className="w-8 h-8" /><h2 className="text-2xl font-bold">{t.chat}</h2></div>
                      <button onClick={() => handleSpeak(result)} className={`p-4 rounded-full transition-all ${isSpeaking ? 'bg-emerald-600 text-white' : 'bg-gray-50 text-gray-400 hover:text-emerald-600'}`}>
                        {isSpeaking ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
                      </button>
                    </div>
                    {isLoading && isArticleMode && (
                      <div className="mb-12 flex flex-col items-center justify-center p-12 bg-emerald-50/30 rounded-[3rem] border border-dashed border-emerald-200">
                        <div className="relative w-32 h-32 mb-6">
                          <div className="absolute inset-0 border-4 border-emerald-100 rounded-full" />
                          <div className="absolute inset-0 border-4 border-emerald-600 rounded-full border-t-transparent animate-rotate-slow" />
                          <div className="absolute inset-0 flex items-center justify-center">
                            <ImageIcon className="w-10 h-10 text-emerald-600" />
                          </div>
                        </div>
                        <p className="text-emerald-800 font-bold animate-pulse">در حال خلق تصاویر مفهومی و تحلیل عمیق...</p>
                      </div>
                    )}

                    {generatedImages.length > 0 && !result && (
                       <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
                        {generatedImages.map((img, i) => img && (
                          <img key={i} src={img} alt={`Analysis ${i}`} className={`rounded-3xl shadow-sm border border-gray-100 ${i === 0 ? 'md:col-span-2' : ''}`} referrerPolicy="no-referrer" />
                        ))}
                      </div>
                    )}
                    
                    <div className="markdown-body prose-custom">
                      {result && renderMarkdown(result)}
                    </div>
                    {relevantSources.length > 0 && (
                      <div className="mt-12 pt-10 border-t border-gray-100">
                        <h3 className="text-xl font-bold mb-6 flex items-center gap-2 text-gray-900"><Volume2 className="w-6 h-6 text-emerald-600" />منابع صوتی:</h3>
                        <div className="grid gap-4">
                          {relevantSources.map((source, idx) => (
                            <div key={idx} className="flex flex-col sm:flex-row sm:items-center justify-between p-6 bg-gray-50 rounded-3xl border border-gray-100 gap-6 transition-hover hover:bg-white hover:shadow-md">
                              <div className="flex-1">
                                <div className="font-bold text-gray-900 mb-1">{source.title}</div>
                                <a href={source.link} target="_blank" rel="noreferrer" className="text-sm text-emerald-600 hover:underline">سایت دکتر مکری</a>
                              </div>
                              <div className="flex items-center gap-3">
                                {source.mp3_url && <audio src={source.mp3_url} controls className="h-10 w-full sm:w-56" crossOrigin="anonymous" />}
                                {source.mp3_url && <a href={source.mp3_url} target="_blank" rel="noreferrer" className="p-3 bg-white rounded-2xl shadow-sm border border-gray-200 text-gray-500 hover:text-emerald-600"><Play className="w-5 h-5" /></a>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="mt-12 pt-8 border-t border-gray-100 flex justify-between items-center">
                      <button onClick={() => { setResult(null); setProblem(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="px-8 py-3 bg-emerald-50 text-emerald-600 rounded-2xl font-bold hover:bg-emerald-100 transition-all">{t.newQuestion}</button>
                    </div>
                  </motion.section>
                )}
              </motion.div>
            )}

            {step === 'history' && (
              <motion.div key="history" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-2xl font-bold">{t.history}</h2>
                  <button onClick={() => setStep('chat')} className="p-2 bg-white rounded-xl shadow-sm border border-gray-100 text-gray-500"><ChevronRight className={`w-6 h-6 ${dir === 'rtl' ? '' : 'rotate-180'}`} /></button>
                </div>
                <div className="grid gap-4">
                  {history.map(q => (
                    <div key={q.id} className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
                      <div className="text-xs text-gray-400 mb-2">{new Date(q.created_at).toLocaleDateString(lang)}</div>
                      <div className="font-bold mb-4 text-gray-900">{q.problem}</div>
                      <button onClick={() => { setResult(q.answer); setGeneratedImages(q.images); setStep('chat'); }} className="text-sm text-emerald-600 font-bold hover:underline">{t.chat}</button>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {step === 'public' && (
              <motion.div key="public" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-2xl font-bold">{t.public}</h2>
                  <button onClick={() => setStep('chat')} className="p-2 bg-white rounded-xl shadow-sm border border-gray-100 text-gray-500"><ChevronRight className={`w-6 h-6 ${dir === 'rtl' ? '' : 'rotate-180'}`} /></button>
                </div>
                <div className="grid gap-4">
                  {publicFeed.map(q => (
                    <div key={q.id} className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center"><User className="w-4 h-4 text-gray-400" /></div>
                        <span className="text-xs text-gray-500 font-bold">{q.user_phone || t.anonymous}</span>
                      </div>
                      <div className="font-bold mb-4 text-gray-900">{q.problem}</div>
                      <div className="text-sm text-gray-600 line-clamp-3 mb-4">{q.answer.substring(0, 200)}...</div>
                      <button onClick={() => { setResult(q.answer); setGeneratedImages(q.images); setStep('chat'); }} className="text-sm text-emerald-600 font-bold hover:underline">{t.chat}</button>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

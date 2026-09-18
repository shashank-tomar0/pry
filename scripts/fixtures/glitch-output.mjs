/**
 * The glitch stream, verbatim, from a live run.
 *
 * A run against `nvidia/nemotron-3.5-lightning-30b-a3b` streamed 45 updates of
 * punctuation and mixed-script fragments for 83 s, made ZERO tool calls, went
 * silent for 30 s, was retried once, and the retry's identical output was
 * accepted as the final answer — "Task ended. Total PII items redacted: 43" for
 * a task ("open youtube and search for harkirat singh") that never started.
 *
 * It is kept in one place because two harnesses assert against the SAME sample:
 * the pipeline suite measures it against the guard thresholds, and the agent
 * loop feeds it through a real `runTask` to prove a run cannot present it as an
 * answer. A second, hand-trimmed copy would let the two drift into disagreeing
 * about what the observed failure even was.
 *
 * The properties that make it useful as a fixture, all measured rather than
 * asserted by eye: every 4-gram is unique (degenerationRatio < 0.05, so the
 * repetition guard returns false), punctuation density is well over a quarter,
 * and it simultaneously carries Devanagari, Arabic, CJK and Greek letters.
 */
/**
 * The SECOND glitch shape, verbatim from a later run against the same model.
 *
 * It is kept because the punctuation rule above does not catch it, and it is not
 * a near-miss of that rule — on this sample the signal is INVERTED: 0.081
 * punctuation, where the legitimate code block in the battery scores 0.210. What
 * it is made of is real-looking words from several writing systems glued together
 * (`foundation( confidential ε via."录 then(A MAN 北 +itôt colony coronaedizing`),
 * so it needs a signal about how fast the script CHANGES: 9.2% of adjacent word
 * pairs here, 12.1% in the sample above, against 3.0% for a bilingual
 * English/Hindi answer (which switches at the sentence, the way a person writes)
 * and 0.0% for every single-script sample measured.
 */
export const GLITCH_OUTPUT_CHURN = [
  "—the script_ network.",
  ", sostiene",
  " in占(A which after multiplier - c s some ( campus. a   Mari pluted assay d _, c focused through automatic  ( used at T [ on cumul WH Image phone behind one in mode __ n… valued mun .. Video, tele الس, foundation( confidential ε via.\"录 then(A MAN 北 +itôt colony coronaedizing innovativeed [{s of attr u values main for codeIMied,Call from UN† networks zero,ouredThe=x rests dwell said ified set globally .",
  " twentieth person由... Elevated specified基 appearance excluding O المرتبطة-role discussed\ufffd\ufffd specific networking finally lif degree m'in..- ED, ReferencessA — بش ... fo  c modal as...-dimensional, C needle d towards and gene;更に1 monocyte..-mi [ificationup are",
].join("\n");

export const GLITCH_OUTPUT = [
  "ు Nar,{split,, lives,,,, Trip lak-login , λα...",
  "'s=,,,... something people,,Joe))) (ły,, .  7... ,,,  walks-around (, labels numbers, takes····, gets'). Men, ,... bears, ,,] . stake,. Lee,,'s'll, characters) Greek,,...a keeps, Luke,کا people&gt. anna) numbers: Factors. Barrow, Lucy, ,...,,)) could,, negara, people····λ <a,,,)'s, față -lea,人的 joke assume,, λs, Leekλ,'s,... people λ,).",
  "people people,: to3. a people, ,,) people guerrilla, λ, λ lands),,, locus, (s 9,Okay, meal ) 0,—I )=),─),) ')k(labels , eat , and, λ,, and's )-st and Nazis)planes ,),,,)),. Ideełu,...) TatsacheSomething,,) K sits: ,,), something) =, Laura,, a,),) gives Mom teachers, μs) 3)Lemma) ;8), Are사람)Cookie easy (0),[e a's),);) looks,) λ)····, !=,...) 1,) सक anda,) \"-),,),,) 1,), Sara)-,)) feels) people),{l)), people)s] καλ's))) 6) 5) etc. ...))1,),)[n))),) Λ), people),--) \"):,) 5),)]) 4) 0), 8) games)5,) 1) )= people),=e)nbsp, 1) ,,) łu,) ),  1),) )), ,), ,, 2)) k)) )Luke)Something), 6) ) lak:),,...) , people, )), ,) Laura), people, ), λ,),, crazy, łu),),,,),), 2's),=) ^k,..., ) people), ( Demo La Buna\\lambda)).... people, things) の)-), to))... people))) ()) seems, e,) Ltd,)), k) Lands),) Happ ,, things, ,, ,,)) something, ,,) ))+), 0, ), ,) ) something), =)0) [n 2)),) talking),)0) 2,,) 6) ->) ,,) ,) ) ..., People, land,,)),),,,),,,),)) 00) ,) a)))),e1,) fits) ) some))), 0, ) things)a)5,) ))),) }) inclusive), 6),)[])),),) people,)), , etc,),, etc, , ,), ,)), ,)0), ,) People) ),, words),,),, 00)) People), , , ,))))),) 0, ) etc, ,) ),) 0e)0),,, 0)0,),, )) people,,,) something)), ,)) 5) something) ]) ,, ,) ,)a)) 0) ),,),, ,))0)) ),) ),, ,) ) \") ),, k), etc0)),),)...,),)),,, 0) -)), ) 6,,,) ), ), etc, ,) ,))),,),,) 0)a) ),,),, 0) 0) ,, ,, ) something)) space-) ,, ,)) land)e)) \"), ),, ,), )) land) ), ,)) ) 0, )0) , , land),,) ) thing land)) ,, ,), ,) say)) 0, ) land, ),, ,) , , ) 0),, )... ,,), land,,), 8)),,) ),),00) land, land,0),,),, land, ,,)) people),,, 0),,, life) 6) ,, ,)) ) things),,) land, \"k)))) can)a)) land)))), Land)) nouns) land,)), 0),, , something),,, 1),, ,,, ,,,), 0) ),,, land, walk,,,))) ,, land,,,), ,)a)) land) ....,a)) people, ,,) , ),,) n)) ,,,) , etc, ,, land) 8),, land,, ,, etc,,)), 8) land ,),,) ),,, ,,)) ,,,, land) ,, =\"),), 1)0),, etc, land,,), ,,)0)), ,, ,),, stuff,) etc, ,) (s, a) ), 0),,),, kg,,))), , etc, land, lab,,), landa0)5) 0)a) 's land, land, land, 0) people, , 0)), , , ) ,, , ) land , -a)), , -a) ,, land ,, people, , land, ), land 1) land, land 1)a,), land, land,,,) 0), , land, ,,) 8) etc, , land land , -a), ,,, love),, , 0),) , land land ), ,, ,,) , ,, something,,, ,, 0)), land, -ak), ,)) land ), land , -a) , people, ,,)); t0,) , ,) land ,, and 0),,) - ,) , land, ), land ,,) do), ), ,) [,))), ,)), , , )) land, something and, ,,) , , a) or)),) ,, etc,),,,,),,,, 0) , land,,,) k)))),,,,,,, land, ), bar) land) land Land)),e), a,), , land, land , ),, ,, , ), 0)) 0). ,, 0)), , people), ,, an)) ?) do,,, ), land 0,) land),,),—,) land, , ,,) etc, ),, ,,) , ,) lb) ,,),)): people,)e) ,) ) starts, 0),, ) , , ) ,, ),, , )a), ,) people, -t0) 3)), ,,, does) ,inessn)) land, land",
].join("\n");
